#!/usr/bin/env python3
"""fixtures.py — generate HEIC test fixtures + native reference decodes for libheif-js.

Uses the NATIVE libheif shared library (conda-forge libheif 1.23.7, which has x265 +
libde265 built in; pixi.toml provides it) through ctypes, so no heif-enc CLI is needed.

  pixi run fixtures                      # = python test/fixtures.py "" work/fixtures
  python3 fixtures.py <libheif.so|""> <outdir>   ("" = $CONDA_PREFIX/lib/libheif.so)

Writes <outdir>/<name>.heic, <name>.ref.rgba (native decode, RGBA8, irot/imir applied)
and fixtures.json ([{name, file, width, height, has_alpha, bytes, notes}]).
All pixel content is synthetic (gradients, edges, deterministic noise) — no personal data.
"""
import ctypes as C
import json
import os
import struct
import sys

import numpy as np


class HeifError(C.Structure):
    _fields_ = [("code", C.c_int), ("subcode", C.c_int), ("message", C.c_char_p)]


def load(path):
    L = C.CDLL(path)
    for fn in ("heif_context_get_encoder_for_format", "heif_encoder_set_lossy_quality",
               "heif_image_create", "heif_image_add_plane", "heif_context_encode_image",
               "heif_context_add_exif_metadata", "heif_context_write_to_file",
               "heif_context_add_grid_image", "heif_context_add_image_tile",
               "heif_context_read_from_file", "heif_context_get_primary_image_handle",
               "heif_decode_image", "heif_context_set_primary_image",
               "heif_encoder_set_parameter_string"):
        getattr(L, fn).restype = HeifError
    L.heif_context_alloc.restype = C.c_void_p
    L.heif_encoding_options_alloc.restype = C.c_void_p
    L.heif_decoding_options_alloc.restype = C.c_void_p
    L.heif_image_get_plane2.restype = C.c_void_p
    L.heif_image_get_plane2.argtypes = [C.c_void_p, C.c_int, C.POINTER(C.c_size_t)]
    L.heif_image_get_plane_readonly2.restype = C.c_void_p
    L.heif_image_get_plane_readonly2.argtypes = [C.c_void_p, C.c_int, C.POINTER(C.c_size_t)]
    L.heif_image_get_width.argtypes = [C.c_void_p, C.c_int]
    L.heif_image_get_height.argtypes = [C.c_void_p, C.c_int]
    L.heif_get_version.restype = C.c_char_p
    return L


def ok(e, what):
    if e.code != 0:
        raise RuntimeError(f"{what}: {e.code}/{e.subcode} {e.message}")


RGB, IL_RGB, IL_RGBA, CH_IL = 1, 10, 11, 10


def make_image(L, arr):
    h, w, c = arr.shape
    img = C.c_void_p()
    ok(L.heif_image_create(w, h, RGB, IL_RGBA if c == 4 else IL_RGB, C.byref(img)), "image_create")
    ok(L.heif_image_add_plane(img, CH_IL, w, h, 8), "add_plane")
    stride = C.c_size_t()
    p = L.heif_image_get_plane2(img, CH_IL, C.byref(stride))
    buf = (C.c_uint8 * (stride.value * h)).from_address(p)
    dst = np.frombuffer(buf, dtype=np.uint8).reshape(h, stride.value)
    dst[:, : w * c] = arr.reshape(h, w * c)
    return img


def encoder(L, ctx, q=85):
    enc = C.c_void_p()
    ok(L.heif_context_get_encoder_for_format(ctx, 1, C.byref(enc)), "get_encoder(HEVC)")
    ok(L.heif_encoder_set_lossy_quality(enc, q), "quality")
    ok(L.heif_encoder_set_parameter_string(enc, b"preset", b"faster"), "preset")
    return enc


def options(L, orientation=1):
    o = L.heif_encoding_options_alloc()
    # struct heif_encoding_options (x86_64): version u8 @0, ..., nclx ptr @8,
    # macOS_..._no_nclx u8 @16, image_orientation enum(int) @20 (version >= 5).
    assert C.c_uint8.from_address(o).value >= 5
    C.c_int.from_address(o + 20).value = orientation
    return o


def photo(w, h, seed, alpha=False):
    """Photo-like synthetic content: sky/ground gradients, hard edges, texture, noise."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    r = 40 + 180 * (x / w) + 20 * np.sin(y / 37.0)
    g = 60 + 150 * (y / h) + 25 * np.cos(x / 53.0)
    b = 200 - 140 * (y / h) + 30 * np.sin((x + y) / 91.0)
    disc = ((x - w * 0.62) ** 2 + (y - h * 0.4) ** 2) < (min(w, h) * 0.18) ** 2
    r[disc], g[disc], b[disc] = 235, 200, 60
    bars = ((x // max(8, w // 64)) % 2 == 0) & (y > h * 0.75)
    r[bars] *= 0.4; g[bars] *= 0.4; b[bars] *= 0.4
    rgb = np.stack([r, g, b], -1) + rng.normal(0, 6, (h, w, 3))
    out = np.clip(rgb, 0, 255).astype(np.uint8)
    if alpha:
        a = np.clip(255 * (x / w) * (0.3 + 0.7 * (y / h)), 0, 255).astype(np.uint8)
        a[disc] = 255
        a[: h // 8, :] = 0  # fully transparent band
        out = np.concatenate([out, a[..., None]], -1)
    return np.ascontiguousarray(out)


def exif_with_gps():
    """Minimal little-endian TIFF/EXIF: IFD0 {Make, Orientation=1, GPS IFD ptr}, GPS IFD
    {lat ref/lat, lon ref/lon} — a public landmark-free test coordinate (0.5 N, 100.5 E)."""
    def rat(n, d=1):
        return struct.pack("<II", n, d)
    make = b"FixtureCam\x00"
    # layout: header(8) IFD0 @8: 3 entries -> 2+3*12+4 = 42 -> GPS IFD @50: 4 entries -> 2+48+4 = 54
    gps_off = 8 + 42
    data_off = gps_off + 54
    make_off = data_off
    lat_off = make_off + len(make)
    lon_off = lat_off + 24
    ifd0 = struct.pack("<H", 3)
    ifd0 += struct.pack("<HHII", 0x010F, 2, len(make), make_off)
    ifd0 += struct.pack("<HHIHH", 0x0112, 3, 1, 1, 0)
    ifd0 += struct.pack("<HHII", 0x8825, 4, 1, gps_off)
    ifd0 += struct.pack("<I", 0)
    gps = struct.pack("<H", 4)
    gps += struct.pack("<HHI4s", 0x0001, 2, 2, b"N\x00\x00\x00")
    gps += struct.pack("<HHII", 0x0002, 5, 3, lat_off)
    gps += struct.pack("<HHI4s", 0x0003, 2, 2, b"E\x00\x00\x00")
    gps += struct.pack("<HHII", 0x0004, 5, 3, lon_off)
    gps += struct.pack("<I", 0)
    tiff = b"II*\x00" + struct.pack("<I", 8) + ifd0 + gps + make
    tiff += rat(0) + rat(30) + rat(0)       # 0 deg 30 min 0 sec
    tiff += rat(100) + rat(30) + rat(0)
    assert len(ifd0) == 42 and len(gps) == 54
    return tiff


def write(L, ctx, path):
    ok(L.heif_context_write_to_file(ctx, path.encode()), "write")


def ref_decode(L, path):
    ctx = L.heif_context_alloc()
    ok(L.heif_context_read_from_file(C.c_void_p(ctx), path.encode(), None), "read")
    h = C.c_void_p()
    ok(L.heif_context_get_primary_image_handle(C.c_void_p(ctx), C.byref(h)), "primary")
    img = C.c_void_p()
    ok(L.heif_decode_image(h, C.byref(img), RGB, IL_RGBA, None), "decode")
    w = L.heif_image_get_width(img, CH_IL)
    hh = L.heif_image_get_height(img, CH_IL)
    stride = C.c_size_t()
    p = L.heif_image_get_plane_readonly2(img, CH_IL, C.byref(stride))
    raw = np.frombuffer((C.c_uint8 * (stride.value * hh)).from_address(p), dtype=np.uint8)
    rgba = raw.reshape(hh, stride.value)[:, : w * 4].copy()
    has_alpha = L.heif_image_handle_has_alpha_channel(h)
    L.heif_image_release(img); L.heif_image_handle_release(h); L.heif_context_free(C.c_void_p(ctx))
    return w, hh, bool(has_alpha), rgba.tobytes()


def main():
    lib = sys.argv[1] or os.path.join(os.environ["CONDA_PREFIX"], "lib", "libheif.so")
    L = load(lib)
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    print("native libheif", L.heif_get_version().decode())
    specs = []

    def single(name, arr, notes, orientation=1, exif=None):
        ctx = L.heif_context_alloc()
        enc = encoder(L, C.c_void_p(ctx))
        img = make_image(L, arr)
        hnd = C.c_void_p()
        ok(L.heif_context_encode_image(C.c_void_p(ctx), img, enc, C.c_void_p(options(L, orientation)),
                                       C.byref(hnd)), "encode")
        if exif:
            ok(L.heif_context_add_exif_metadata(C.c_void_p(ctx), hnd, exif, len(exif)), "exif")
        write(L, C.c_void_p(ctx), os.path.join(out, name + ".heic"))
        specs.append((name, notes))

    def grid(name, w, h, tile, notes, orientation=1):
        """iPhone layout: hvc1 tiles of tile x tile in a grid whose output size is
        smaller than cols*tile (the right/bottom tiles are cropped by the grid)."""
        cols, rows = -(-w // tile), -(-h // tile)
        full = photo(cols * tile, rows * tile, seed=7)
        ctx = C.c_void_p(L.heif_context_alloc())
        enc = encoder(L, ctx)
        gh = C.c_void_p()
        ok(L.heif_context_add_grid_image(ctx, w, h, cols, rows, C.c_void_p(options(L, orientation)),
                                         C.byref(gh)), "add_grid")
        for ty in range(rows):
            for tx in range(cols):
                t = np.ascontiguousarray(full[ty * tile:(ty + 1) * tile, tx * tile:(tx + 1) * tile])
                ok(L.heif_context_add_image_tile(ctx, gh, tx, ty, make_image(L, t), enc), "add_tile")
        ok(L.heif_context_set_primary_image(ctx, gh), "set_primary")
        write(L, ctx, os.path.join(out, name + ".heic"))
        specs.append((name, notes + f"; grid {cols}x{rows} of {tile}px tiles"))

    grid("iphone_grid_4032x3024", 4032, 3024, 512, "iPhone-like 12 MP grid HEIC")
    grid("iphone_grid_portrait_irot", 4032, 3024, 512, "12 MP grid with irot (EXIF orientation 6 -> 3024x4032)",
         orientation=6)
    single("single_4032x3024", photo(4032, 3024, 1), "12 MP single hvc1 item (non-grid)")
    single("exif_gps_1600x1200", photo(1600, 1200, 2), "EXIF with GPS IFD", exif=exif_with_gps())
    single("alpha_800x600", photo(800, 600, 3, alpha=True), "RGBA with alpha plane (gradient + transparent band)")
    single("odd_1001x667", photo(1001, 667, 4), "odd dimensions (4:2:0 chroma edge)")

    meta = []
    for name, notes in specs:
        path = os.path.join(out, name + ".heic")
        w, h, a, rgba = ref_decode(L, path)
        with open(os.path.join(out, name + ".ref.rgba"), "wb") as f:
            f.write(rgba)
        meta.append({"name": name, "file": name + ".heic", "width": w, "height": h, "has_alpha": a,
                     "bytes": os.path.getsize(path), "notes": notes})
        print(f"{name}: {w}x{h} alpha={a} {os.path.getsize(path)} B")
    with open(os.path.join(out, "fixtures.json"), "w") as f:
        json.dump(meta, f, indent=1)


if __name__ == "__main__":
    main()
