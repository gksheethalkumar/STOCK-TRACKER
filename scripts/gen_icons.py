#!/usr/bin/env python3
"""Generate PWA/app icons with zero dependencies (stdlib zlib + struct).

Draws a dark rounded tile with a green upward trend line + arrow.
Outputs public/icons/icon-192.png and icon-512.png.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "icons")

BG = (11, 15, 23)          # app background
TILE = (19, 26, 38)        # rounded tile
GREEN = (46, 194, 107)
GREEN_DIM = (32, 120, 74)


def rounded(x, y, w, h, r):
    """Is pixel (x,y) inside a rounded rect [0..w]x[0..h] with radius r."""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    for (cx, cy) in ((r, r), (w - r, r), (r, h - r), (w - r, h - r)):
        if ((x < r and y < r and (cx, cy) == (r, r)) or
                (x > w - r and y < r and (cx, cy) == (w - r, r)) or
                (x < r and y > h - r and (cx, cy) == (r, h - r)) or
                (x > w - r and y > h - r and (cx, cy) == (w - r, h - r))):
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                return False
    return True


def make(size):
    s = size
    pad = int(s * 0.10)
    tw = s - 2 * pad
    r = int(tw * 0.24)

    # polyline (in tile-local coords, 0..1) forming an upward trend
    pts = [(0.10, 0.72), (0.30, 0.55), (0.45, 0.63), (0.62, 0.38), (0.80, 0.24)]
    px = [(pad + p[0] * tw, pad + p[1] * tw) for p in pts]
    line_w = max(2.0, s * 0.035)

    def near_line(x, y):
        best = 1e9
        for i in range(len(px) - 1):
            ax, ay = px[i]
            bx, by = px[i + 1]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            t = 0 if L2 == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
            projx, projy = ax + t * dx, ay + t * dy
            d = ((x - projx) ** 2 + (y - projy) ** 2) ** 0.5
            best = min(best, d)
        return best

    # arrowhead near the last point
    hx, hy = px[-1]

    rows = bytearray()
    for y in range(s):
        rows.append(0)  # filter type 0
        for x in range(s):
            col = BG
            lx, ly = x - pad, y - pad
            if rounded(lx, ly, tw, tw, r):
                col = TILE
                d = near_line(x, y)
                if d <= line_w:
                    col = GREEN
                elif d <= line_w + 1.5:
                    col = GREEN_DIM
                # arrowhead (two short strokes up-left and down-left from head)
                if ((x - hx) ** 2 + (y - hy) ** 2) ** 0.5 <= line_w * 3.2 and x <= hx + line_w:
                    ah = min(
                        seg_dist(x, y, hx, hy, hx - tw * 0.14, hy + tw * 0.02),
                        seg_dist(x, y, hx, hy, hx - tw * 0.02, hy + tw * 0.14),
                    )
                    if ah <= line_w:
                        col = GREEN
            rows += bytes(col)
    return s, rows


def seg_dist(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L2))
    projx, projy = ax + t * dx, ay + t * dy
    return ((x - projx) ** 2 + (y - projy) ** 2) ** 0.5


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size, rows):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        s, rows = make(size)
        write_png(os.path.join(OUT, f"icon-{size}.png"), s, rows)
        print("wrote", os.path.join(OUT, f"icon-{size}.png"))


if __name__ == "__main__":
    main()
