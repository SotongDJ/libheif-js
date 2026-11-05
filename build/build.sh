#!/usr/bin/env bash
# build.sh — reproducible recipe for dist/libheif.js:
# libheif (decoder only) + libde265 compiled by Emscripten to PLAIN JavaScript
# (wasm2js, -sWASM=0), no embind, no dynamic execution, so it runs under a
# `Content-Security-Policy: script-src 'self'` page with no 'unsafe-eval' and
# no 'wasm-unsafe-eval'.
#
# Usage (from the repository root):
#   pixi run build                  # = bash build/build.sh work
#   bash build/build.sh <WORK>      # with emcc 4.0.9, cmake, make, curl on PATH
#   Output: <WORK>/out/{libheif.js,heic-worker.js}. Compare with dist/ (see README).
#   SKIP_LIBS=1 relinks only (reuses the static libs from the previous full build).
#   JOBS=<n> parallel compile jobs (default 2). EM_CACHE=<dir> to share emscripten's
#   compiled sysroot between builds (default <WORK>/emcache).
#
# Toolchain: conda-forge emscripten 4.0.9 (pixi.toml). Its conda package pins
# binaryen 117, which rejects the feature flags emcc 4.0.9 passes
# (--enable-bulk-memory-opt); emcc expects binaryen 123, so the official
# binaryen version_123 release binaries are fetched (hash-pinned, matches
# upstream's .sha256) and used via EM_BINARYEN_ROOT. Linux x86_64 only as written.
set -euo pipefail

WORK=${1:?usage: build.sh <workdir>}
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
JOBS=${JOBS:-2}   # each emcc C++ job peaks around 350 MB

LIBHEIF_VER=1.23.7
LIBHEIF_URL=https://github.com/strukturag/libheif/releases/download/v${LIBHEIF_VER}/libheif-${LIBHEIF_VER}.tar.gz
LIBHEIF_SHA=f7483e818503ea6224c8863e4a56ac02c7089021a98472c811c12aa19faf2475
LIBDE265_VER=1.1.3
LIBDE265_URL=https://github.com/strukturag/libde265/releases/download/v${LIBDE265_VER}/libde265-${LIBDE265_VER}.tar.gz
LIBDE265_SHA=554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905
BINARYEN_VER=123
BINARYEN_URL=https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VER}/binaryen-version_${BINARYEN_VER}-x86_64-linux.tar.gz
BINARYEN_SHA=e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe

command -v emcc >/dev/null || { echo "build.sh: emcc not on PATH (use: pixi run build)" >&2; exit 2; }
case "$(emcc --version | head -1 | awk '{print $NF}')" in 4.0.9|4.0.9-git) true ;; *) false ;; esac || [ -n "${ALLOW_OTHER_EMCC:-}" ] || {
  echo "build.sh: expected emcc 4.0.9, got: $(emcc --version | head -1)" >&2; exit 2; }

mkdir -p "$WORK"/{dl,src,tmp,prefix,build-de265,build-heif,out}
WORK=$(cd "$WORK" && pwd)
# EM_CACHE = emscripten's compiled sysroot (a toolchain cache; safe to share).
export EM_CACHE="${EM_CACHE:-$WORK/emcache}"
mkdir -p "$EM_CACHE"
export TMPDIR="$WORK/tmp" EMCC_TEMP_DIR="$WORK/tmp"
export EM_BINARYEN_ROOT="$WORK/src/binaryen-version_${BINARYEN_VER}"

fetch() { # url sha256
  local f="$WORK/dl/$(basename "$1")"
  [ -s "$f" ] || curl -sSLf -m 900 -o "$f" "$1"
  echo "$2  $f" | sha256sum -c --quiet - || { echo "build.sh: sha256 mismatch for $f" >&2; exit 1; }
}
fetch "$LIBHEIF_URL" "$LIBHEIF_SHA"
fetch "$LIBDE265_URL" "$LIBDE265_SHA"
fetch "$BINARYEN_URL" "$BINARYEN_SHA"

[ -x "$EM_BINARYEN_ROOT/bin/wasm-opt" ] || (cd "$WORK/src" && tar xzf "$WORK/dl/$(basename "$BINARYEN_URL")")
"$EM_BINARYEN_ROOT/bin/wasm-opt" --version
COMMON_CFLAGS="-O3 -DNDEBUG"

if [ -z "${SKIP_LIBS:-}" ]; then   # SKIP_LIBS=1: relink only, reuse the two static libs
cd "$WORK/src"
rm -rf "libheif-$LIBHEIF_VER" "libde265-$LIBDE265_VER"
tar xzf "$WORK/dl/libheif-$LIBHEIF_VER.tar.gz"
tar xzf "$WORK/dl/libde265-$LIBDE265_VER.tar.gz"

# ── libde265 (static, decoder library only, no SIMD) ─────────────────────────
rm -rf "$WORK/build-de265"/* "$WORK/prefix"/*
emcmake cmake -S "$WORK/src/libde265-$LIBDE265_VER" -B "$WORK/build-de265" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/prefix" \
  -DCMAKE_C_FLAGS="$COMMON_CFLAGS" -DCMAKE_CXX_FLAGS="$COMMON_CFLAGS" \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_SDL=OFF -DENABLE_SIMD=OFF -DENABLE_AVX2=OFF -DENABLE_AVX512=OFF \
  -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DWITH_FUZZERS=OFF
cmake --build "$WORK/build-de265" -j "$JOBS"
cmake --install "$WORK/build-de265"
DE265_A=$(find "$WORK/prefix" -name 'libde265.a' | head -1)
[ -s "$DE265_A" ] || { echo "build.sh: libde265.a not produced" >&2; exit 1; }

# ── libheif (static, HEVC decode via libde265 only; every other codec off) ───
rm -rf "$WORK/build-heif"/*
# __EMSCRIPTEN_STANDALONE_WASM__ only gates `#include "heif_emscripten.h"` (the embind
# binding) in libheif/api/libheif/heif.cc — defining it drops embind without patching
# upstream; our shim is the binding instead. Nothing else in either tree reads it.
HEIF_CFLAGS="$COMMON_CFLAGS -D__EMSCRIPTEN_STANDALONE_WASM__=1"
emcmake cmake -S "$WORK/src/libheif-$LIBHEIF_VER" -B "$WORK/build-heif" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$HEIF_CFLAGS" -DCMAKE_CXX_FLAGS="$HEIF_CFLAGS" \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_PLUGIN_LOADING=OFF \
  -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
  -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF \
  -DLIBDE265_INCLUDE_DIR="$WORK/prefix/include" -DLIBDE265_LIBRARY="$DE265_A" \
  -DWITH_X265=OFF -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF \
  -DWITH_X264=OFF -DWITH_OpenH264_DECODER=OFF -DWITH_DAV1D=OFF -DWITH_AOM_DECODER=OFF \
  -DWITH_AOM_ENCODER=OFF -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_JPEG_DECODER=OFF \
  -DWITH_JPEG_ENCODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=OFF \
  -DWITH_FFMPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF -DWITH_UNCOMPRESSED_CODEC=OFF \
  -DWITH_WEBCODECS=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_HEADER_COMPRESSION=OFF \
  -DWITH_EXAMPLES=OFF -DWITH_EXAMPLE_HEIF_THUMB=OFF -DWITH_EXAMPLE_HEIF_VIEW=OFF \
  -DWITH_GDK_PIXBUF=OFF -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF -DWITH_FUZZERS=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON -DCMAKE_DISABLE_FIND_PACKAGE_Brotli=ON
cmake --build "$WORK/build-heif" -j "$JOBS" --target heif
fi
DE265_A=$(find "$WORK/prefix" -name 'libde265.a' | head -1)
HEIF_A="$WORK/build-heif/libheif/libheif.a"
[ -s "$HEIF_A" ] || { echo "build.sh: libheif.a not produced" >&2; exit 1; }

# ── link: shim + libheif + libde265 -> wasm2js plain JS ─────────────────────
cd "$WORK/out"
emcc $COMMON_CFLAGS "$HERE/heifjs_shim.c" \
  -I"$WORK/src/libheif-$LIBHEIF_VER/libheif/api" -I"$WORK/build-heif" \
  "$HEIF_A" "$DE265_A" \
  -o libheif.core.js \
  -sWASM=0 -sDYNAMIC_EXECUTION=0 -sENVIRONMENT=web,worker \
  -sMODULARIZE=1 -sEXPORT_NAME=createLibheifModule \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=1MB \
  -sFILESYSTEM=0 -sASSERTIONS=0 -sSUPPORT_LONGJMP=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_hj_decode,_hj_free,_hj_version \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32 \
  -sINCOMING_MODULE_JS_API=print,printErr \
  -lstdc++

# ── wasm2js shim rename ──────────────────────────────────────────────────────
# With -sWASM=0 emscripten declares a LOCAL `var WebAssembly={Memory,Module,Instance,
# instantiate,RuntimeError,isWasm2js:true}` shim inside the module factory; every
# `WebAssembly` token in the output is that local var (the native API is never
# reached: CSP without 'wasm-unsafe-eval' would refuse it anyway). Rename it so the
# output carries no `WebAssembly` token at all and cannot be mistaken for native wasm.
[ "$(grep -o 'var WebAssembly={' libheif.core.js | wc -l)" = 1 ] || {
  echo "build.sh: expected exactly one local wasm2js 'var WebAssembly={' shim" >&2; exit 1; }
sed -i 's/\bWebAssembly\b/Wasm2jsShim/g' libheif.core.js

# ── assemble the single distributable file ──────────────────────────────────
{
  printf '/*! libheif-js %s — libheif %s + libde265 %s compiled to plain JavaScript (Emscripten %s, wasm2js).\n' \
    "$LIBHEIF_VER" "$LIBHEIF_VER" "$LIBDE265_VER" "$(emcc --version | head -1 | awk '{print $NF}')"
  printf ' * libheif and libde265 are LGPL-3.0-or-later; see LICENSES/ beside this file. Source and build recipe: the libheif-js repository (build/). */\n'
  printf '(function(){\n'
  cat libheif.core.js
  printf '\n'
  cat "$HERE/api.js"
  printf '})();\n'
} > libheif.js
cp "$HERE/heic-worker.js" heic-worker.js
rm -f libheif.core.js

# ── CSP gate: these literal tokens must not occur in the distributable files ─
gate_fail=0
for tok in 'eval(' 'new Function' 'Function(' 'WebAssembly' 'blob:' 'data:' 'import(' 'createObjectURL'; do
  for f in libheif.js heic-worker.js; do
    n=$(grep -cF -- "$tok" "$f" || true)
    echo "gate: $f '$tok' = $n"
    [ "$n" = 0 ] || gate_fail=1
  done
done
[ "$gate_fail" = 0 ] || { echo "build.sh: CSP token gate FAILED" >&2; exit 1; }
ls -l "$WORK/out"
sha256sum "$WORK/out"/*
