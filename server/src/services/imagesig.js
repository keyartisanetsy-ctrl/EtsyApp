/**
 * A free way to tell whether two photos show the same thing: no AI, no
 * network, no credits. Each picture is boiled down to a small fingerprint of
 * its colours - which hues it is made of, how light or dark it is, how much of
 * it is colourful at all - after setting the background aside, because a
 * product on a studio's white sweep and the same product on a warehouse floor
 * have nothing in common but the product.
 *
 * It is a ranking aid, not a verdict: two different things can share a palette.
 * It is good at "this is the orange-and-blue box, not the green keycaps", and
 * it is never what decides a match on its own.
 */
import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { getDb } from '../db/index.js';

const SIDE = 64;
const HUE_BINS = 12;
const LIGHT_BINS = 4;
const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const r3 = (n) => Math.round(n * 1000) / 1000;

/** Decode a JPEG or PNG into RGBA pixels; anything else (WebP, GIF, HEIC) is not read. */
export function decodeImage(buf) {
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
      return { width: img.width, height: img.height, data: img.data };
    }
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const img = PNG.sync.read(buf);
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch { /* a damaged or unsupported file simply has no fingerprint */ }
  return null;
}

/** Average the picture down to at most SIDE pixels on its long edge, over white where it is transparent. */
function shrink({ width, height, data }) {
  const k = Math.max(1, Math.max(width, height) / SIDE);
  const w = Math.max(1, Math.round(width / k));
  const h = Math.max(1, Math.round(height / k));
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * width + xx) * 4;
          const a = data[i + 3] / 255;
          r += data[i] * a + 255 * (1 - a);
          g += data[i + 1] * a + 255 * (1 - a);
          b += data[i + 2] * a + 255 * (1 - a);
          n += 1;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { w, h, px: out };
}

function hsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/**
 * The fingerprint. The background is whatever colour the picture's border is
 * mostly made of; only pixels that differ from it count - unless that leaves
 * almost nothing or almost everything (a close-up that fills the frame), in
 * which case the whole picture counts.
 */
export function computeSignature(image) {
  const { w, h, px } = shrink(image);
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.08));
  let br = 0; let bg = 0; let bb = 0; let bn = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
      const o = (y * w + x) * 3;
      br += px[o]; bg += px[o + 1]; bb += px[o + 2]; bn += 1;
    }
  }
  br /= bn; bg /= bn; bb /= bn;

  const isFg = new Uint8Array(w * h);
  let fgCount = 0;
  for (let i = 0; i < w * h; i += 1) {
    const dr = px[i * 3] - br; const dg = px[i * 3 + 1] - bg; const db = px[i * 3 + 2] - bb;
    if (Math.sqrt(dr * dr + dg * dg + db * db) > 48) { isFg[i] = 1; fgCount += 1; }
  }
  const useAll = fgCount < w * h * 0.06 || fgCount > w * h * 0.94;

  const hue = new Float64Array(HUE_BINS);
  const light = new Float64Array(LIGHT_BINS);
  let counted = 0; let colourful = 0; let mr = 0; let mg = 0; let mb = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!useAll && !isFg[i]) continue;
    const r = px[i * 3]; const g = px[i * 3 + 1]; const b = px[i * 3 + 2];
    const { h: hh, s, v } = hsv(r, g, b);
    counted += 1; mr += r; mg += g; mb += b;
    light[Math.min(LIGHT_BINS - 1, Math.floor(v * LIGHT_BINS))] += 1;
    if (s >= 0.22 && v >= 0.18) {
      colourful += 1;
      // Split each pixel between its two nearest hue bins so a hue near a
      // boundary does not flip a whole bin.
      const pos = hh / (360 / HUE_BINS) - 0.5;
      const lo = Math.floor(pos);
      const frac = pos - lo;
      const wgt = s * v;
      hue[((lo % HUE_BINS) + HUE_BINS) % HUE_BINS] += wgt * (1 - frac);
      hue[(((lo + 1) % HUE_BINS) + HUE_BINS) % HUE_BINS] += wgt * frac;
    }
  }
  const norm = (arr) => { const t = arr.reduce((a, v) => a + v, 0); return Array.from(arr, (v) => (t > 0 ? r3(v / t) : 0)); };
  return {
    v: 1,
    hue: norm(hue),
    light: norm(light),
    colourful: r3(counted ? colourful / counted : 0),
    mean: counted ? [Math.round(mr / counted), Math.round(mg / counted), Math.round(mb / counted)] : [0, 0, 0],
  };
}

const overlap = (a, b) => a.reduce((s, v, i) => s + Math.min(v, b[i]), 0);

/** 0..1 - how alike two fingerprints are. Around 0.9 and up is "the same colours"; under ~0.6 is "something else". */
export function similarity(a, b) {
  if (!a || !b) return null;
  const bothColourful = Math.min(a.colourful, b.colourful);
  // Two mostly grey/black/white things say nothing through their hues.
  const hueSim = a.colourful < 0.1 && b.colourful < 0.1 ? 1 : overlap(a.hue, b.hue);
  const wHue = 0.25 + 0.45 * Math.min(1, bothColourful / 0.4);
  const lightSim = overlap(a.light, b.light);
  const cf = 1 - Math.abs(a.colourful - b.colourful);
  const dist = Math.hypot(a.mean[0] - b.mean[0], a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]);
  const meanSim = 1 - clamp(dist / 200);
  const core = wHue * hueSim + (0.85 - wHue) * lightSim + 0.15 * cf;
  return clamp(0.9 * core + 0.1 * meanSim);
}

/** The fingerprint of a stored picture, computed once and remembered. Null when the file cannot be read. */
export function signatureFor(attachmentId) {
  if (!attachmentId) return null;
  const db = getDb();
  const known = db.prepare('SELECT signature FROM image_signatures WHERE attachment_id = ?').get(attachmentId);
  if (known) { try { return JSON.parse(known.signature); } catch { /* recompute below */ } }

  const a = db.prepare('SELECT path FROM attachments WHERE id = ?').get(attachmentId);
  if (!a || !fs.existsSync(a.path)) return null;
  const image = decodeImage(fs.readFileSync(a.path));
  if (!image) return null;
  const signature = computeSignature(image);
  db.prepare('INSERT OR REPLACE INTO image_signatures (attachment_id, signature) VALUES (?,?)').run(attachmentId, JSON.stringify(signature));
  return signature;
}
