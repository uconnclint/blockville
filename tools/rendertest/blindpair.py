#!/usr/bin/env python3
"""Blind A/B pair for visual critics.

  python3 tools/rendertest/blindpair.py make OURS.png REF.png OUT.png [--crop x,y,w,h]
      Scales both images to the same height, places them side by side in a
      random order labelled only "A" and "B", and writes OUT.png. The answer key
      is sealed in OUT.png.key (base64 — don't open it until you've judged).

  python3 tools/rendertest/blindpair.py reveal OUT.png
      Prints which side was ours. Run this only AFTER writing down your verdict.
"""
import sys, random, base64, json
from PIL import Image, ImageDraw, ImageFont

def load(p, crop=None):
    im = Image.open(p).convert('RGB')
    if crop:
        x, y, w, h = crop
        im = im.crop((x, y, x + w, y + h))
    return im

def make(ours, ref, out, crop=None):
    a, b = load(ours, crop), load(ref)
    H = 900
    a = a.resize((max(1, round(a.width * H / a.height)), H), Image.LANCZOS)
    b = b.resize((max(1, round(b.width * H / b.height)), H), Image.LANCZOS)
    ours_left = random.random() < 0.5
    L, R = (a, b) if ours_left else (b, a)
    gap, bar = 24, 56
    sheet = Image.new('RGB', (L.width + R.width + gap, H + bar), (30, 30, 30))
    sheet.paste(L, (0, bar)); sheet.paste(R, (L.width + gap, bar))
    d = ImageDraw.Draw(sheet)
    try: f = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 40)
    except Exception: f = None
    d.text((20, 6), 'A', fill=(255, 255, 255), font=f)
    d.text((L.width + gap + 20, 6), 'B', fill=(255, 255, 255), font=f)
    sheet.save(out)
    key = json.dumps({'ours': 'A' if ours_left else 'B'})
    open(out + '.key', 'w').write(base64.b64encode(key.encode()).decode())
    print(out)

def reveal(out):
    print(json.loads(base64.b64decode(open(out + '.key').read()))['ours'] + ' was ours')

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'make':
        crop = None
        if '--crop' in sys.argv:
            crop = tuple(int(v) for v in sys.argv[sys.argv.index('--crop') + 1].split(','))
        make(sys.argv[2], sys.argv[3], sys.argv[4], crop)
    elif cmd == 'reveal':
        reveal(sys.argv[2])
