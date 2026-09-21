"""Porovnání fotek podle obsahu (bez PIL): 32×32 šedotónový otisk přes sips→BMP, skóre = průměrný abs. rozdíl 0..255."""
import os, struct, subprocess, tempfile

def fingerprint(path, size=32):
    with tempfile.TemporaryDirectory() as t:
        bmp = os.path.join(t, "f.bmp")
        # -z výška šířka: natvrdo na čtverec, ať se porovnává stejně bez ohledu na orientaci/ořez
        subprocess.run(["sips", "-z", str(size), str(size), "-s", "format", "bmp", path, "--out", bmp],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        d = open(bmp, "rb").read()
    off = struct.unpack("<I", d[10:14])[0]; w, h = struct.unpack("<ii", d[18:26]); bpp = struct.unpack("<H", d[28:30])[0] // 8
    row = (w * bpp + 3) & ~3; px = []
    for y in range(abs(h)):
        base = off + y * row
        px.append([sum(d[base + x * bpp: base + x * bpp + 3]) / 3 for x in range(w)])
    if h > 0: px.reverse()          # BMP bývá odspodu
    flat = [v for r in px for v in r]; m = sum(flat) / len(flat)
    return [v - m for v in flat]    # bez jasu, ať nevadí jiná expozice

def distance(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)
