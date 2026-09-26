#!/usr/bin/env python3
"""Make a NIGHT version of a reference image so night renders get a fair,
like-for-like blind pair (the reference pack has no night shots).

  python3 tools/rendertest/nightref.py REF.jpg OUT.png

Deterministic: cool moonlit grade (value down, blue shift), blue glass pixels
become warm lit windows in per-block patches (~55% lit), bright white/yellow
signage glows, asphalt stays near-black. It is a fixed transform, not an art
pass, so every night critic sees the same night reference."""
import sys
import numpy as np
from PIL import Image, ImageFilter

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(np.float32) / 255
r, g, b = a[..., 0], a[..., 1], a[..., 2]
L = 0.2126 * r + 0.7152 * g + 0.0722 * b

# Moonlit grade: keep structure (top/left/right values) but darken and cool.
night = np.stack([r * 0.30 + L * 0.06, g * 0.36 + L * 0.08, b * 0.52 + L * 0.16], -1)
night = night ** 1.08

# Windows: saturated blue glass -> warm light, in ~6px blocks with a hash so
# whole windows switch together and ~45% stay dark.
glass = (b > r + 0.18) & (b > g + 0.05) & (b > 0.35) & (L < 0.75) & (r > 0.09)   # r>0.09 excludes pool water (r~0)
H, W = L.shape
yy, xx = np.mgrid[0:H, 0:W]
cell = ((xx // 7) * 73856093 ^ (yy // 6) * 19349663) & 1023
lit = glass & (cell < 560)
warm = np.array([1.0, 0.78, 0.42], np.float32)
cool = np.array([0.85, 0.92, 1.0], np.float32)
pick = ((cell % 7) == 0)[..., None]
glow = np.where(pick, cool, warm) * (0.75 + 0.25 * L[..., None])
night = np.where(lit[..., None], glow, night)

# Signs / bright emissive-looking accents (very bright, saturated yellow/white).
sign = (r > 0.85) & (g > 0.55) & (b < 0.45)   # saturated yellow/orange signage only (not white roofs)
night = np.where(sign[..., None], np.clip(a * 1.0, 0, 1), night)

# Gentle bloom from lit pixels.
lum = Image.fromarray((np.clip(night, 0, 1) * 255).astype('uint8'))
bright = Image.fromarray(((lit | sign) * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(6))
bl = np.asarray(bright).astype(np.float32)[..., None] / 255
night = np.clip(night + bl * np.array([0.35, 0.25, 0.12]), 0, 1)
Image.fromarray((night * 255).astype('uint8')).save(out)
print('wrote', out)
