#!/bin/bash
# One-shot face-ratio measurement on a white probe cube (see faceprobe.js).
#   tools/rendertest/faceratio.sh OUTDIR ["extra js run before the probe, e.g. BV.engine._keyAzOffset=-1.7"]
# Prints: top/left/right RGB and luma ratio top : left : right.
# Reference target (ref04, same albedo): 1 : 0.89 : 0.63.
cd "$(dirname "$0")/../.." || exit 2
OUT=${1:?outdir}; EXTRA=${2:-1}; mkdir -p "$OUT"
LOAD="(async()=>{(0,eval)(await (await fetch('/tools/rendertest/faceprobe.js',{cache:'no-store'})).text());return 1})()"
node tools/rendertest/shoot.mjs --out "$OUT" --shots iso-close --eval "$LOAD.then(()=>{ $EXTRA ; return 1})" --post "BVFACEPROBE(6)" > "$OUT/probe.json" || exit 1
python3 - "$OUT" <<'EOF'
import json, sys
from PIL import Image
out = sys.argv[1]
d = json.loads(open(out + '/probe.json').read().strip().splitlines()[-1])
r = d.get('postResult')
if not isinstance(r, dict) or 'faces' not in r: print('probe failed:', d.get('error'), r); sys.exit(1)
im = Image.open(out + '/iso-close.png').convert('RGB'); k = r['dpr']
L = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
res = {}
for f, (x, y) in r['faces'].items():
    X, Y = int(x * k), int(y * k)
    if not (6 <= X < im.width - 6 and 6 <= Y < im.height - 6): print('face off-screen:', f, X, Y); sys.exit(1)
    px = [im.getpixel((X + i, Y + j)) for i in range(-6, 7) for j in range(-6, 7)]
    res[f] = tuple(sum(p[c] for p in px) // len(px) for c in range(3))
t = L(res['top'])
print('top', res['top'], 'left', res['left'], 'right', res['right'])
print('ratio 1 : %.2f : %.2f   (target 1 : 0.89 : 0.63)' % (L(res['left']) / t, L(res['right']) / t))
x, y = r['faces']['top']
im.crop((max(0, int(x * k) - 220), max(0, int(y * k) - 160), int(x * k) + 220, int(y * k) + 320)).save(out + '/probe-crop.png')
EOF
