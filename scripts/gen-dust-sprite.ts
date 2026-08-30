#!/usr/bin/env bun
/**
 * Bakes public/dust.png — the impact-dust sprite sheet used by the deal-in
 * animation (see dustBlast() in public/app.js).
 *
 * Why bake instead of generating in the browser: the same render costs ~300ms
 * of blocked main thread on a mid-range phone, plus a canvas toDataURL(), and
 * it would run on every cold load. Baked, it is one cacheable, precached PNG.
 *
 * Layout: 16 frames across, 2 rows.
 *   row 0 — compact puff, used by the canvas particle sim
 *   row 1 — wide ground-hugging cloud, used as a single CSS-masked element
 *
 * The sheet is rendered white with a varying alpha channel so the app can use
 * it as a CSS mask and supply the colour itself via --dust — one asset that
 * works in both light and dark themes.
 *
 * Deterministic: seeded PRNG, so re-running produces a byte-identical file.
 * Run with `bun scripts/gen-dust-sprite.ts`.
 */
import { deflateSync } from "node:zlib";

const FRAMES = 16;
const SIZE = 128;
const ROWS = 2;
const W = SIZE * FRAMES;
const H = SIZE * ROWS;

/** Deterministic PRNG — a fixed seed keeps the baked PNG reproducible. */
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const easeOut = (t: number) => 1 - Math.pow(1 - t, 2.2);

type RowOpts = { seed: number; lobes: number; holes: number; flat: number; rise: number };

/**
 * Renders one row of frames into `alpha` (a W*H float buffer, 0..1).
 *
 * Lobes get their heading once and are then evolved across all frames, which
 * is what makes the cloud billow coherently rather than boil like noise. A
 * second pass erodes it with holes that drift outward too, so the silhouette
 * tears apart at the edges instead of staying a tidy blob.
 *
 * Compositing mirrors canvas2d exactly: lobes are source-over, holes are
 * destination-out — the browser-side lab and this baker stay in sync.
 */
function renderRow(alpha: Float32Array, row: number, o: RowOpts) {
  const rnd = mulberry32(o.seed);
  const L = Array.from({ length: o.lobes }, () => ({
    ang: rnd() * Math.PI * 2,
    dist: 0.16 + rnd() * 0.46,
    r0: 0.09 + rnd() * 0.13,
    grow: 0.7 + rnd() * 1.5,
    lag: rnd() * 0.3,
    buoy: 0.5 + rnd() * 0.9,
  }));
  const Hs = Array.from({ length: o.holes }, () => ({
    ang: rnd() * Math.PI * 2,
    dist: rnd() * 0.55,
    r: 0.05 + rnd() * 0.13,
    lag: rnd() * 0.4,
  }));

  const rowY = row * SIZE;

  for (let f = 0; f < FRAMES; f++) {
    const p = f / (FRAMES - 1);
    const ox = f * SIZE;
    const cx = ox + SIZE / 2;
    const cy = rowY + SIZE / 2;
    // fade in fast, dissipate slowly
    const a = p < 0.12 ? p / 0.12 : Math.pow(1 - (p - 0.12) / 0.88, 1.5);

    for (const l of L) {
      const pp = Math.max(0, (p - l.lag) / (1 - l.lag));
      const d = l.dist * SIZE * 0.5 * easeOut(pp);
      const r = (l.r0 + l.grow * 0.13 * pp) * SIZE * 0.5;
      const x = cx + Math.cos(l.ang) * d * o.flat;
      const y = cy + Math.sin(l.ang) * d * 0.55 - pp * SIZE * o.rise * l.buoy;
      paint(alpha, x, y, r, ox, rowY, (t) => {
        // matches the canvas gradient stops: 0 -> .42a, .5 -> .22a, 1 -> 0
        const v = t < 0.5 ? 0.42 * a + (t / 0.5) * (0.22 * a - 0.42 * a)
                          : 0.22 * a * (1 - (t - 0.5) / 0.5);
        return v;
      }, false);
    }

    for (const h of Hs) {
      const pp = Math.max(0, (p - h.lag) / (1 - h.lag));
      if (pp <= 0) continue;
      const d = h.dist * SIZE * 0.5 * easeOut(pp) * o.flat;
      const x = cx + Math.cos(h.ang) * d;
      const y = cy + Math.sin(h.ang) * d * 0.6 - pp * SIZE * 0.06;
      const r = h.r * SIZE * (0.6 + pp * 1.1);
      const strength = 0.15 + 0.6 * p;
      paint(alpha, x, y, r, ox, rowY, (t) => strength * (1 - t), true);
    }
  }
}

/**
 * Composites one radial shape. `erase` switches from source-over to
 * destination-out. Iterates the shape's bounding box only — full-image loops
 * would be ~40x more work for no visual difference.
 */
function paint(
  alpha: Float32Array,
  cx: number, cy: number, r: number,
  clipX: number, clipY: number,
  profile: (t: number) => number,
  erase: boolean,
) {
  const x0 = Math.max(clipX, Math.floor(cx - r));
  const x1 = Math.min(clipX + SIZE - 1, Math.ceil(cx + r));
  const y0 = Math.max(clipY, Math.floor(cy - r));
  const y1 = Math.min(clipY + SIZE - 1, Math.ceil(cy + r));
  const rr = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr) continue;
      const v = profile(Math.sqrt(d2) / r);
      if (v <= 0) continue;
      const i = y * W + x;
      const dst = alpha[i] ?? 0;
      alpha[i] = erase ? dst * (1 - v) : v + dst * (1 - v);
    }
  }
}

/* ---------------- minimal PNG encoder (RGBA, no deps) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

function encodePNG(width: number, height: number, rgba: Uint8Array) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // Filter type 1 (Sub) per scanline: RGB is constant white, so Sub collapses
  // the colour channels to zeroes and the sheet compresses to a few tens of KB.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x] as number;
      const left = x >= 4 ? (rgba[y * stride + x - 4] as number) : 0;
      raw[o + 1 + x] = (cur - left) & 0xff;
    }
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(chunk("IHDR", ihdr)),
    Buffer.from(chunk("IDAT", new Uint8Array(idat))),
    Buffer.from(chunk("IEND", new Uint8Array(0))),
  ]);
}

/* ---------------- build ---------------- */

const alpha = new Float32Array(W * H);
renderRow(alpha, 0, { seed: 7, lobes: 16, holes: 26, flat: 1.25, rise: 0.10 });
renderRow(alpha, 1, { seed: 21, lobes: 20, holes: 34, flat: 1.9, rise: 0.06 });

const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = 255;
  rgba[i * 4 + 1] = 255;
  rgba[i * 4 + 2] = 255;
  rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((alpha[i] as number) * 255)));
}

const png = encodePNG(W, H, rgba);
await Bun.write("public/dust.png", png);
console.log(`public/dust.png  ${W}x${H}  ${(png.length / 1024).toFixed(1)} KB`);
