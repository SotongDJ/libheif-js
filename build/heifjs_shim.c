/*
 * heifjs_shim.c — the only C entry points exported by the plain-JS libheif build.
 *
 * Replaces libheif's embind binding (embind generates code with `new Function`,
 * which `script-src 'self'` forbids). JS calls these through Module._hj_* and
 * reads the result struct straight out of HEAP32/HEAPU8 — no runtime codegen.
 *
 * Result struct (wasm32: every field 4 bytes), 256 bytes total:
 *   +0   int32  code      0 = ok; <0 shim error; >0 libheif heif_error_code
 *   +4   int32  width     decoded width (after irot/imir transformations)
 *   +8   int32  height
 *   +12  int32  has_alpha 1 if the primary image carries an alpha plane
 *   +16  uint8* rgba      tightly packed RGBA, width*height*4 bytes (malloc'ed)
 *   +20  int32  n_images  number of top-level images in the file
 *   +24  int32  subcode   libheif heif_suberror_code
 *   +28  char   msg[228]  NUL-terminated error message
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later (links libheif + libde265)
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libheif/heif.h>

#define HJ_MSG_LEN 228

typedef struct {
  int32_t code;
  int32_t width;
  int32_t height;
  int32_t has_alpha;
  uint8_t* rgba;
  int32_t n_images;
  int32_t subcode;
  char msg[HJ_MSG_LEN];
} hj_result;

_Static_assert(sizeof(hj_result) == 256, "hj_result layout is part of the JS ABI");

static void set_msg(hj_result* r, int32_t code, int32_t sub, const char* m) {
  r->code = code;
  r->subcode = sub;
  strncpy(r->msg, m ? m : "", HJ_MSG_LEN - 1);
  r->msg[HJ_MSG_LEN - 1] = 0;
}

static int set_err(hj_result* r, struct heif_error e) {
  if (e.code == heif_error_Ok) return 0;
  set_msg(r, (int32_t)e.code, (int32_t)e.subcode, e.message);
  return 1;
}

const char* hj_version(void) { return heif_get_version(); }

/*
 * Decode the PRIMARY image of a HEIF/HEIC file held in `data[0..len)`.
 * `max_pixels` (width*height, before transformations) is enforced both by the
 * shim (on the ispe size, before any allocation) and by libheif's own security
 * limits (which also cap each grid tile and the overall memory budget).
 * `strict` != 0 makes damaged input an error (see below).
 * Always returns a result struct (NULL only if malloc of the struct fails);
 * free it with hj_free().
 */
hj_result* hj_decode(const uint8_t* data, uint32_t len, uint32_t max_pixels, int32_t strict) {
  hj_result* r = (hj_result*)calloc(1, sizeof(hj_result));
  if (!r) return NULL;

  struct heif_context* ctx = heif_context_alloc();
  struct heif_image_handle* h = NULL;
  struct heif_image* img = NULL;
  struct heif_decoding_options* opt = NULL;
  if (!ctx) { set_msg(r, -1, 0, "out of memory (context)"); return r; }

  heif_security_limits* lim = heif_context_get_security_limits(ctx);
  if (lim) {
    lim->max_image_size_pixels = (uint64_t)max_pixels;
    /* RGBA output + YUV planes + one tile in flight stays well under this. */
    lim->max_total_memory = (uint64_t)max_pixels * 12u + (64u << 20);
  }

  if (set_err(r, heif_context_read_from_memory_without_copy(ctx, data, len, NULL))) goto done;
  r->n_images = heif_context_get_number_of_top_level_images(ctx);
  if (set_err(r, heif_context_get_primary_image_handle(ctx, &h))) goto done;

  {
    uint64_t w = (uint64_t)heif_image_handle_get_ispe_width(h);
    uint64_t hh = (uint64_t)heif_image_handle_get_ispe_height(h);
    if (w == 0 || hh == 0) { set_msg(r, -3, 0, "image has no size"); goto done; }
    if (w * hh > (uint64_t)max_pixels) { set_msg(r, -2, 0, "image exceeds the pixel cap"); goto done; }
  }
  r->has_alpha = heif_image_handle_has_alpha_channel(h) ? 1 : 0;

  opt = heif_decoding_options_alloc();
  if (!opt) { set_msg(r, -1, 0, "out of memory (options)"); goto done; }
  opt->ignore_transformations = 0; /* apply irot/imir/clap: what the camera meant */
  opt->convert_hdr_to_8bit = 1;    /* 10-bit HEIC (e.g. some Android) -> 8-bit RGBA */
  /* strict: a truncated/corrupt file (e.g. missing grid tiles) is an error instead of
   * an image with blank tiles. libheif's default is lenient; JS passes strict=1
   * unless the caller asks for {lenient: true}. */
  opt->strict_decoding = strict ? 1 : 0;

  if (set_err(r, heif_decode_image(h, &img, heif_colorspace_RGB,
                                   heif_chroma_interleaved_RGBA, opt))) goto done;

  {
    int w = heif_image_get_width(img, heif_channel_interleaved);
    int hh = heif_image_get_height(img, heif_channel_interleaved);
    size_t stride = 0;
    const uint8_t* p = heif_image_get_plane_readonly2(img, heif_channel_interleaved, &stride);
    if (!p || w <= 0 || hh <= 0) { set_msg(r, -4, 0, "decoder returned no pixels"); goto done; }
    size_t row = (size_t)w * 4u;
    uint8_t* out = (uint8_t*)malloc(row * (size_t)hh);
    if (!out) { set_msg(r, -1, 0, "out of memory (rgba)"); goto done; }
    for (int y = 0; y < hh; y++) memcpy(out + row * (size_t)y, p + stride * (size_t)y, row);
    r->rgba = out;
    r->width = w;
    r->height = hh;
    r->code = 0;
  }

done:
  if (opt) heif_decoding_options_free(opt);
  if (img) heif_image_release(img);
  if (h) heif_image_handle_release(h);
  heif_context_free(ctx);
  return r;
}

void hj_free(hj_result* r) {
  if (!r) return;
  free(r->rgba);
  free(r);
}
