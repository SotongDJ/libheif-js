# libheif-js — licences and source

`libheif.js` is a compiled (Emscripten → plain JavaScript, wasm2js) build of two LGPL
libraries plus a small shim and API from this repository:

| Component | Version | Source (sha256) | Licence | Text |
|---|---|---|---|---|
| libheif | 1.23.7 | https://github.com/strukturag/libheif/releases/download/v1.23.7/libheif-1.23.7.tar.gz (`f7483e818503ea6224c8863e4a56ac02c7089021a98472c811c12aa19faf2475`) | LGPL-3.0-or-later | `libheif-COPYING` |
| libde265 | 1.1.3 | https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz (`554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905`) | LGPL-3.0-or-later | `libde265-COPYING` |
| `build/heifjs_shim.c`, `build/api.js`, `build/heic-worker.js`, `build/build.sh` | this repository | this repository | LGPL-3.0-or-later | `../LICENSE`, `../COPYING` |
| Emscripten runtime glue, musl libc, libc++/libc++abi, compiler-rt, dlmalloc (linked in by emcc) | Emscripten 4.0.9 | https://github.com/emscripten-core/emscripten/tree/4.0.9 | MIT / UIUC-NCSA (Emscripten); MIT (musl); Apache-2.0 WITH LLVM-exception (libc++, compiler-rt); public domain (dlmalloc) | upstream |

Each `*-COPYING` file is the upstream file verbatim: a short preamble, the full GNU
LGPL v3 text, the full GNU GPL v3 text that the LGPL v3 incorporates, and the MIT
licence upstream uses for its sample applications (not part of this build).
No upstream source file is modified; every build switch is in `build/build.sh`.

## If you serve `libheif.js` to browsers

Serving the file is *conveying* the libraries in object-code form (LGPL v3 §4 with
GPL v3 §6). In practice:

1. **Notice and licence texts** (LGPL §4a, §4b): keep the header comment of
   `libheif.js` and serve this `LICENSES/` directory beside it.
2. **Corresponding source** (GPL v3 §6, via LGPL §4d/§4e): point to this repository
   (recipe, shim, API) and the upstream tarballs listed above, which it uses
   unmodified. If those locations could disappear, keep your own copy of them so you
   can still answer a source request.
3. **Replaceability** (LGPL §4d): keep `libheif.js` a separate file that your code
   talks to only through `HeicDecode`, so a user can swap in their own build
   (`build/build.sh` reproduces it). Do not merge it into your own minified bundle.
4. **No extra restrictions**: your terms must not forbid modifying the library or
   reverse engineering for debugging such modifications (LGPL §4).

This is a practical summary, not legal advice; the licence texts are authoritative.
