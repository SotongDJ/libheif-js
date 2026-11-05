/* ---- HeicDecode API (hand-written; appended after the emscripten module) ----
 * Plain JS that runs under CSP `script-src 'self'`: no string-to-code evaluation,
 * no runtime code generation, no object-URL/inline workers or imports, no native
 * wasm, no network (the build's grep gate checks the literal tokens).
 *
 *   HeicDecode.decode(u8 [, {maxPixels, maxBytes, lenient}])
 *     maxPixels default 100e6 (width*height); maxBytes default 64 MiB;
 *     lenient=true returns damaged files (e.g. truncated grids) with blank tiles
 *     instead of rejecting them (libheif's own default).
 *     -> Promise<[{width, height, rgba: Uint8ClampedArray, hasAlpha, imageCount}]>
 *   Decodes the PRIMARY image only (the array has exactly one entry; extra
 *   top-level images, thumbnails, depth/gain maps are not returned —
 *   `imageCount` says how many top-level images the file has).
 *   Errors reject with an Error whose .code is one of
 *     'EINPUT' | 'ETOOBIG' | 'EPIXELS' | 'EDECODE' | 'EABORT'.
 *   HeicDecode.reset()   drops the module instance (frees its heap).
 *   HeicDecode.version   libheif version string (after the first decode).
 */
(function (root) {
  "use strict";
  var factory = createLibheifModule; // defined by the emscripten part above
  var DEFAULTS = { maxPixels: 100000000, maxBytes: 64 * 1024 * 1024 };
  var modPromise = null;
  var queue = Promise.resolve();

  function fail(code, msg) {
    var e = new Error(msg);
    e.code = code;
    return e;
  }

  function getModule() {
    if (!modPromise) {
      modPromise = factory({
        print: function () {},
        printErr: function () {},
      });
    }
    return modPromise;
  }

  function isHeifBrand(u8) {
    // ISO-BMFF: size(4) 'ftyp'(4) major_brand(4) ...
    return u8.length >= 12 &&
      u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70;
  }

  function decodeNow(u8, opts) {
    var maxPixels = Math.floor(opts.maxPixels);
    var maxBytes = Math.floor(opts.maxBytes);
    if (!(maxPixels > 0) || maxPixels > 0xffffffff) throw fail("EINPUT", "bad maxPixels");
    if (u8.length > maxBytes) throw fail("ETOOBIG", "file is " + u8.length + " bytes; cap is " + maxBytes);
    if (!isHeifBrand(u8)) throw fail("EINPUT", "not an ISO-BMFF/HEIF file (no ftyp box)");
    return getModule().then(function (M) {
      if (!HeicDecode.version) {
        var vp = M._hj_version(), s = "";
        for (var c; (c = M.HEAPU8[vp]) !== 0; vp++) s += String.fromCharCode(c);
        HeicDecode.version = s;
      }
      var inPtr = M._malloc(u8.length || 1);
      if (!inPtr) throw fail("EDECODE", "out of memory (input)");
      var res = 0;
      try {
        M.HEAPU8.set(u8, inPtr);
        res = M._hj_decode(inPtr, u8.length, maxPixels >>> 0, opts.lenient ? 0 : 1);
        if (!res) throw fail("EDECODE", "out of memory (result)");
        var H32 = M.HEAP32, b = res >> 2;
        var code = H32[b], w = H32[b + 1], h = H32[b + 2];
        var hasAlpha = H32[b + 3] === 1, rgbaPtr = H32[b + 4] >>> 0, n = H32[b + 5];
        if (code !== 0) {
          var mp = res + 28, msg = "";
          for (var ch; (ch = M.HEAPU8[mp]) !== 0 && mp < res + 256; mp++) msg += String.fromCharCode(ch);
          var kind = code === -2 || code === 6 /* heif_error_Memory_allocation_error */ ||
            /security limit|exceeds/i.test(msg) ? "EPIXELS" : "EDECODE";
          throw fail(kind, "HEIC decode failed (" + code + "/" + H32[b + 6] + "): " + msg);
        }
        // Copy out of the heap: the heap may be replaced by memory growth or reset().
        var rgba = new Uint8ClampedArray(w * h * 4);
        rgba.set(M.HEAPU8.subarray(rgbaPtr, rgbaPtr + w * h * 4));
        return [{ width: w, height: h, rgba: rgba, hasAlpha: hasAlpha, imageCount: n }];
      } finally {
        if (res) M._hj_free(res);
        M._free(inPtr);
      }
    });
  }

  var HeicDecode = {
    version: "",
    decode: function (input, options) {
      var opts = {
        maxPixels: (options && options.maxPixels) || DEFAULTS.maxPixels,
        maxBytes: (options && options.maxBytes) || DEFAULTS.maxBytes,
        lenient: !!(options && options.lenient),
      };
      var u8;
      if (input instanceof Uint8Array) u8 = input;
      else if (input instanceof ArrayBuffer) u8 = new Uint8Array(input);
      else return Promise.reject(fail("EINPUT", "decode() takes a Uint8Array or ArrayBuffer"));
      // One decode at a time per module instance (the C heap is shared).
      var run = queue.then(function () { return decodeNow(u8, opts); });
      queue = run.then(function () {}, function () {});
      return run.catch(function (e) {
        if (e && e.code) throw e;
        // Anything else is an emscripten abort (e.g. OOM): the instance is unusable.
        modPromise = null;
        throw fail("EABORT", "decoder aborted: " + (e && e.message ? e.message : String(e)));
      });
    },
    reset: function () { modPromise = null; },
  };

  root.HeicDecode = HeicDecode;
})(typeof self !== "undefined" ? self : this);
