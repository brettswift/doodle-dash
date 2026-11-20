#!/usr/bin/env python3
"""Render best/worst from an archive record JSON to PNG: render-drawing.py rec.json best|worst out.png"""
import json, sys
from PIL import Image, ImageDraw
rec = json.load(open(sys.argv[1])); d = rec[sys.argv[2]]
W, H, S = rec['canvas']['w'], rec['canvas']['h'], 1000
im = Image.new('RGB', (W, H), 'white'); dr = ImageDraw.Draw(im)
for s in d['strokes']:
    pts = [(s['p'][i] * W / S, s['p'][i + 1] * H / S) for i in range(0, len(s['p']), 2)]
    if len(pts) == 1: pts = pts * 2
    dr.line(pts, fill=s['c'], width=s['w'], joint='curve')
    for x, y in pts: dr.ellipse([x - s['w'] / 2, y - s['w'] / 2, x + s['w'] / 2, y + s['w'] / 2], fill=s['c'])
im.save(sys.argv[3])
