// Canvas <-> normalized (0..1000 on both axes) mapping. Shared by browser and tests.
(function (root) {
  'use strict';
  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
  // rect: canvas getBoundingClientRect(); ins: optional content-box {l,t,w,h} inside rect (border/padding).
  function toNorm(clientX, clientY, rect, ins) {
    const l = ins ? ins.l : 0, t = ins ? ins.t : 0;
    const w = ins ? ins.w : rect.width, h = ins ? ins.h : rect.height;
    return [clamp((clientX - rect.left - l) / w * 1000), clamp((clientY - rect.top - t) / h * 1000)];
  }
  // Each axis scales by its own backing-store size (was: one 0.8 factor for both -> y stretched 1.33x).
  const toPixel = (p, w, h) => [p[0] * w / 1000, p[1] * h / 1000];
  const lineScale = (w) => w / 1000;
  const api = { toNorm, toPixel, lineScale };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DDGeom = api;
})(typeof self !== 'undefined' ? self : this);
