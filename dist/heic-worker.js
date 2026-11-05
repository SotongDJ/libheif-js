/* heic-worker.js — same-origin worker FILE wrapper around libheif.js.
 * `script-src 'self'` allows `new Worker('/path/heic-worker.js')` (worker-src
 * falls back to script-src); an object-URL worker would be blocked, so never build one.
 * libheif.js must be served from the same directory as this file.
 *
 * Page side:
 *   const w = new Worker('/res/libheif-js/1.23.7/heic-worker.js');
 *   w.postMessage({id, buffer, maxPixels?, maxBytes?, lenient?}, [buffer]);
 *   w.onmessage = ({data}) => data.ok
 *     ? data.images  // [{width, height, rgba: Uint8ClampedArray, hasAlpha, imageCount}]
 *     : data.error;  // {code, message}
 *   RGBA buffers are transferred, not copied. Terminate the worker to free its heap.
 */
"use strict";
importScripts("libheif.js");

self.onmessage = function (ev) {
  var d = ev.data || {};
  var id = d.id;
  var input = d.buffer instanceof ArrayBuffer ? new Uint8Array(d.buffer)
            : d.buffer instanceof Uint8Array ? d.buffer : null;
  if (!input) {
    self.postMessage({ id: id, ok: false, error: { code: "EINPUT", message: "buffer must be an ArrayBuffer or Uint8Array" } });
    return;
  }
  self.HeicDecode.decode(input, { maxPixels: d.maxPixels, maxBytes: d.maxBytes, lenient: d.lenient }).then(
    function (images) {
      self.postMessage({ id: id, ok: true, images: images, version: self.HeicDecode.version },
        images.map(function (im) { return im.rgba.buffer; }));
    },
    function (e) {
      self.postMessage({ id: id, ok: false, error: { code: e.code || "EDECODE", message: String(e.message || e) } });
    }
  );
};
