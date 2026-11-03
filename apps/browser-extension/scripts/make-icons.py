"""Writes icons/icon{16,32,48,128}.png (stdlib only): a blue rounded square with a white globe ring.
Rerun after changing the design: python3 scripts/make-icons.py"""
import os, struct, zlib

def png(size):
    rows = []
    c, r = (size - 1) / 2, size / 2
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = x - c, y - c
            # rounded square: corner radius = size/5
            k = size / 5
            qx, qy = max(abs(dx) - (r - k), 0), max(abs(dy) - (r - k), 0)
            inside = qx * qx + qy * qy <= k * k
            d = (dx * dx + dy * dy) ** 0.5
            ring = abs(d - size * 0.30) <= max(size * 0.06, 1) or (abs(dx) <= max(size * 0.03, 0.5) and d <= size * 0.30) or (abs(dy) <= max(size * 0.03, 0.5) and d <= size * 0.30)
            row += bytes((255, 255, 255, 255) if inside and ring else (29, 78, 216, 255) if inside else (0, 0, 0, 0))
        rows.append(bytes(row))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    with open(os.path.join(out, f"icon{s}.png"), "wb") as f:
        f.write(png(s))
