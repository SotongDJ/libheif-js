# libheif-js — licences and source

`libheif.js` is a compiled (Emscripten → plain JavaScript, wasm2js) build of two LGPL
libraries plus a small shim and API. Source and build recipe:
https://github.com/SotongDJ/libheif-js (`dist/libheif.js` sha256
`b90832ce0e4265d45fdee431971cc837617cd8506f68f09c468a1e4446f146c1`, built from
commit `e9d69c2`).

| Component | Version | Source (sha256) | Licence | Text |
|---|---|---|---|---|
| libheif | 1.23.7 | https://github.com/strukturag/libheif/releases/download/v1.23.7/libheif-1.23.7.tar.gz (`f7483e818503ea6224c8863e4a56ac02c7089021a98472c811c12aa19faf2475`) | LGPL-3.0-or-later | `libheif-COPYING` |
| libde265 | 1.1.3 | https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz (`554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905`) | LGPL-3.0-or-later | `libde265-COPYING` |
| shim `heifjs_shim.c`, API `api.js`, `heic-worker.js`, recipe `build.sh` | libheif-js | https://github.com/SotongDJ/libheif-js (`build/`) | LGPL-3.0-or-later | `libheif-COPYING` (LGPL v3 + GPL v3 texts) |
| Emscripten JS runtime glue + its own libc parts, `libstubs`, `libnoexit` | Emscripten 4.0.9 | https://github.com/emscripten-core/emscripten/tree/4.0.9 | MIT or UIUC/NCSA | `emscripten-LICENSE`, `emscripten-AUTHORS` |
| musl libc (in `libc.a`) | as shipped in Emscripten 4.0.9 | same | MIT | `musl-COPYRIGHT` |
| libc++ (`libc++-noexcept.a`) | as shipped in Emscripten 4.0.9 | same | Apache-2.0 WITH LLVM-exception | `libcxx-LICENSE.TXT` |
| libc++abi (`libc++abi-noexcept.a`) | as shipped in Emscripten 4.0.9 | same | Apache-2.0 WITH LLVM-exception | `libcxxabi-LICENSE.TXT` |
| compiler-rt (`libcompiler_rt.a`) | as shipped in Emscripten 4.0.9 | same | Apache-2.0 WITH LLVM-exception | `compiler-rt-LICENSE.TXT` |
| dlmalloc (`libdlmalloc.a`) | 2.8.6, as shipped in Emscripten 4.0.9 | same | public domain (CC0), by Doug Lea | no text required |

The runtime rows are exactly the system libraries the linker pulled members from
(checked with `wasm-ld --trace`). The LLVM exception means the libc++, libc++abi and
compiler-rt notices are not required for this compiled form; they are included anyway.

Every licence file here is the upstream file verbatim. Each `*-COPYING` file holds a
short preamble, the full GNU
LGPL v3 text, the full GNU GPL v3 text that the LGPL v3 incorporates, and the MIT
licence upstream uses for its sample applications (not part of this build).
No upstream source file is modified; every build switch is in the repository's
`build/build.sh`.

## If you serve `libheif.js` to browsers

Serving the file is *conveying* the libraries in object-code form (LGPL v3 §4 with
GPL v3 §6). In practice:

1. **Notice and licence texts** (LGPL §4a, §4b): keep the header comment of
   `libheif.js` and serve this `LICENSES/` directory beside it.
2. **Corresponding source** (GPL v3 §6, via LGPL §4d/§4e): point to
   https://github.com/SotongDJ/libheif-js (recipe, shim, API) and the upstream
   tarballs listed above, which it uses
   unmodified. If those locations could disappear, keep your own copy of them so you
   can still answer a source request.
3. **Replaceability** (LGPL §4d): keep `libheif.js` a separate file that your code
   talks to only through `HeicDecode`, so a user can swap in their own build
   (`build/build.sh` reproduces it). Do not merge it into your own minified bundle.
4. **No extra restrictions**: your terms must not forbid modifying the library or
   reverse engineering for debugging such modifications (LGPL §4).

This is a practical summary, not legal advice; the licence texts are authoritative.
