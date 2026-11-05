# libheif-js

A HEIC/HEIF decoder for web pages with a strict Content Security Policy.

[libheif](https://github.com/strukturag/libheif) 1.23.7 (decoder only) and
[libde265](https://github.com/strukturag/libde265) 1.1.3, compiled with Emscripten to
**plain JavaScript** (wasm2js, `-sWASM=0`), so it runs on a page served with

```
Content-Security-Policy: script-src 'self'
```

and nothing else: no `'unsafe-eval'`, no `'wasm-unsafe-eval'`, no `'unsafe-inline'`.
The output contains no `eval`, no `new Function`, no native WebAssembly, no `blob:` or
`data:` workers or imports, and makes no network requests. libheif's embind binding
(which generates code at runtime) is replaced by a small C shim and a hand-written API.

Existing browser HEIC decoders need either `'unsafe-eval'` (embind) or a worker built
from a `blob:` URL, both of which `script-src 'self'` refuses. This build needs neither.

## Files

| Path | What |
|---|---|
| `dist/libheif.js` | the decoder: emscripten module + `HeicDecode` API, one classic script |
| `dist/heic-worker.js` | optional same-origin worker wrapper (load from the same directory) |
| `build/build.sh` | the build recipe (fetches pinned sources, builds, links, assembles, gates) |
| `build/heifjs_shim.c` | the C entry points (`hj_decode`, `hj_free`, `hj_version`) |
| `build/api.js` | the `HeicDecode` JavaScript API appended to the module |
| `build/heic-worker.js` | source of `dist/heic-worker.js` |
| `test/fixtures.py` | makes HEIC test files + native reference decodes (ctypes against libheif) |
| `test/browser_test.mjs` | decodes them in headless Chromium under `script-src 'self'` and compares |
| `LICENSE`, `COPYING` | GNU LGPL v3 and the GNU GPL v3 it incorporates |
| `LICENSES/` | upstream licence files of libheif and libde265, and what the LGPL asks of you |

## Use

```html
<script src="/vendor/libheif-js/libheif.js"></script>
```

```js
const [img] = await HeicDecode.decode(new Uint8Array(await file.arrayBuffer()));
const canvas = document.createElement("canvas");
canvas.width = img.width; canvas.height = img.height;
canvas.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
```

`HeicDecode.decode(u8 | ArrayBuffer, options?)` returns
`Promise<[{ width, height, rgba: Uint8ClampedArray, hasAlpha, imageCount }]>`.

- Decodes the **primary image only**; the array always has exactly one entry.
  Thumbnails, depth/gain maps and other top-level images are not returned
  (`imageCount` says how many top-level images the file has).
- Rotation/mirroring (`irot`/`imir`) is applied (libheif's default transformations); grid
  (tiled) images, as written by phone cameras, are assembled; 10-bit input is
  converted to 8-bit RGBA. Without alpha, A = 255.
- `options.maxPixels` (default 100,000,000) — width × height cap, checked before any
  pixel memory is allocated; also passed to libheif's security limits.
- `options.maxBytes` (default 64 MiB) — input size cap.
- `options.lenient` (default `false`) — by default a damaged file (e.g. a truncated
  grid) is an error; `true` restores libheif's lenient behaviour (missing tiles blank).
- Errors reject with an `Error` whose `.code` is `EINPUT`, `ETOOBIG`, `EPIXELS`,
  `EDECODE` or `EABORT` (the module aborted, e.g. out of memory; it is re-created on
  the next call).
- Decodes run one at a time per page. `HeicDecode.reset()` drops the module so its
  heap can be garbage-collected; `HeicDecode.version` is the libheif version.

Pure JavaScript is slower than WebAssembly: a 12-megapixel grid image took about
9–10 s and about 400 MB of renderer memory on a small virtual server. Decode in the
worker so the page stays responsive:

```js
const w = new Worker("/vendor/libheif-js/heic-worker.js");   // same origin, a file, not blob:
w.onmessage = ({ data }) => data.ok ? use(data.images[0]) : fail(data.error); // {code, message}
w.postMessage({ id: 1, buffer, maxPixels, maxBytes, lenient }, [buffer]);
```

The RGBA buffer is transferred back, not copied. Terminate the worker to free its heap.
Under `script-src 'self'`, `worker-src` falls back to `script-src`, so a same-origin
worker file is allowed.

## Build

Linux x86_64 with [pixi](https://pixi.sh) and `curl`:

```
pixi run build            # -> work/out/libheif.js, work/out/heic-worker.js
sha256sum work/out/* dist/*
```

`pixi.toml`/`pixi.lock` pin the toolchain from conda-forge: emscripten 4.0.9 (clang 21),
cmake 4.4.5, make 4.4.1. Without pixi: put emcc 4.0.9, cmake and make on `PATH` and run
`bash build/build.sh work`. A full build takes about 12 minutes with two jobs
(`JOBS=n` to change; each emcc job peaks around 350 MB).

The recipe downloads and checks these, unmodified:

| Source | sha256 |
|---|---|
| https://github.com/strukturag/libheif/releases/download/v1.23.7/libheif-1.23.7.tar.gz | `f7483e818503ea6224c8863e4a56ac02c7089021a98472c811c12aa19faf2475` |
| https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz | `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905` |
| https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | `e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe` |

**Why binaryen 123 is fetched separately:** the conda-forge emscripten 4.0.9 package
pins binaryen 117, which rejects flags emcc 4.0.9 passes (`--enable-bulk-memory-opt`).
emcc 4.0.9 expects binaryen 123, so the official release binaries (hash matches
upstream's `.sha256`) are used through `EM_BINARYEN_ROOT`.

**What is built:** libde265 as a static library without SIMD or tools; libheif as a
static library with HEVC decoding through libde265 only (every other codec, plugin
loading, multithreading, examples and tests off). `-D__EMSCRIPTEN_STANDALONE_WASM__`
is set for libheif only because in libheif 1.23.7 it gates nothing but the embind
binding include. Link flags: `-O3 -sWASM=0 -sDYNAMIC_EXECUTION=0
-sENVIRONMENT=web,worker -sMODULARIZE -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=2GB
-sFILESYSTEM=0`. The local `WebAssembly` stand-in object that wasm2js output declares
is renamed, and the recipe then fails if any of `eval(`, `new Function`, `Function(`,
`WebAssembly`, `blob:`, `data:`, `import(` or `createObjectURL` occurs in the output.

### Reproducibility

`dist/` was built from a fresh clone of this repository with `pixi run build`. The
build is deterministic: earlier clean builds of the same sources in other directories
(which differed only in the wording of the header comment) were byte-identical to it
in every other line.

| File | sha256 |
|---|---|
| `dist/libheif.js` | `b90832ce0e4265d45fdee431971cc837617cd8506f68f09c468a1e4446f146c1` |
| `dist/heic-worker.js` | `829fe4ea28f17ea6458688f744ad5ed8c6e63361aa45ee1330e4282cdea01c3a` |

Compare `sha256sum dist/libheif.js` with the copy a site serves to check that it is
this build.

## Test

```
pixi run -e test fixtures                       # -> work/fixtures (synthetic images)
node test/browser_test.mjs work/out work/fixtures work/src/libheif-1.23.7/fuzzing/data/corpus
```

The browser test needs Node 18+ and the `playwright` package with Chromium. It serves a
page from a routed origin (no listening server) with exactly `script-src 'self'`,
checks that the CSP is enforced (a page script's `eval`, `new Function` and native wasm
are blocked), decodes each fixture on the main thread and in the worker, compares with
the native libheif decode, exercises the error paths, and runs libheif's own fuzzing
corpus (every file must resolve or reject; none may hang).

Result for this build: 6 fixtures (12 MP grid as phone cameras write it, the same with
`irot`, 12 MP single image, EXIF with GPS, alpha, odd dimensions) all decode at the
right size with a maximum per-channel difference of 2 from native libheif (PSNR ≥ 83 dB;
the odd-size image is identical); 0 CSP violations from the library; 0 network
requests; all 134 corpus files resolve or reject cleanly.

## Licence

libheif and libde265 are licensed under the GNU Lesser General Public License v3 or
later. The files in this repository (`build/`, `test/`, the build output in `dist/`)
are licensed under the **GNU LGPL v3 or later** as well: see `LICENSE` and `COPYING`.
`dist/libheif.js` also contains Emscripten's runtime and system libraries (Emscripten:
MIT / UIUC-NCSA; musl: MIT; libc++, compiler-rt: Apache-2.0 WITH LLVM-exception;
dlmalloc: public domain); their licence texts are in `LICENSES/`.

If you serve `dist/libheif.js`, see [`LICENSES/README.md`](LICENSES/README.md) for what
the LGPL asks: keep the notice and licence texts with it, make the corresponding source
available (this repository + the upstream tarballs), and keep `libheif.js` a separate
file so users can replace it with their own build.
