# Regenerate: python3 -I scripts/tray-icon.py src-tauri/icons/tray-template.png
#             python3 -I scripts/tray-icon.py src-tauri/icons/tray-windows.png windows
# Clock face (ring + two hands).
# - macOS: 36x36 (18pt @2x) monochrome template icon, black + alpha only; macOS tints template images
#   for light/dark menu bars.
# - Windows: 32x32 (16px at 200%; Windows scales it down), white glyph with a dark outline so it
#   reads on both light and dark taskbars (Windows does not tint tray icons).
import math, struct, sys, zlib
WIN = sys.argv[2:] == ["windows"]
N, SS = (32 if WIN else 36), 8
K = N / 36  # geometry is designed on the 36 px grid
def cov(x, y, grow):
    hits = 0
    for i in range(SS):
        for j in range(SS):
            px, py = (x + (i + .5) / SS - N / 2) / K, (y + (j + .5) / SS - N / 2) / K
            r = math.hypot(px, py)
            ring = 13.0 - grow <= r <= 16.5 + grow
            def seg(ax, ay, w):  # hand from centre to (ax, ay), half-width w
                t = max(0, min(1, (px * ax + py * ay) / (ax * ax + ay * ay)))
                return math.hypot(px - t * ax, py - t * ay) <= w
            hands = seg(0, -9.5, 1.6 + grow) or seg(7, 0, 1.6 + grow)
            hits += ring or hands
    return hits / (SS * SS)
def pixel(x, y):
    if not WIN:
        return (0, 0, 0, round(255 * cov(x, y, 0)))
    fg, ol = cov(x, y, 0), cov(x, y, 1.6)  # glyph, glyph + outline
    a = fg + ol * (1 - fg)  # white glyph over a dark (#1f2937) outline
    c = lambda d: round((255 * fg + d * ol * (1 - fg)) / a) if a else 0
    return (c(0x1f), c(0x29), c(0x37), round(255 * a))
rows = b"".join(b"\0" + b"".join(bytes(pixel(x, y)) for x in range(N)) for y in range(N))
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
