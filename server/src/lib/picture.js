/**
 * Pictures on their way to Etsy.
 *
 * Etsy takes JPEG, PNG and GIF. Shops and AI tools hand out WebP (and sometimes AVIF, TIFF, BMP) all the time - the
 * address ends in .jpg and the server still answers with WebP - so anything else is converted here, once, on the way in:
 * to JPEG, or to PNG when the picture has see-through parts. The picture itself is not touched beyond that.
 */
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { badRequest } from './errors.js';

/** What kind of picture these bytes are (from their first bytes), or null. */
export function pictureKind(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('ascii', a, b);
  if (buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (ascii(0, 3) === 'GIF') return { mime: 'image/gif', ext: '.gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (ascii(4, 8) === 'ftyp' && /^(avif|avis)$/.test(ascii(8, 12))) return { mime: 'image/avif', ext: '.avif' };
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1)$/.test(ascii(8, 12))) return { mime: 'image/heic', ext: '.heic' };
  if (ascii(0, 2) === 'BM') return { mime: 'image/bmp', ext: '.bmp' };
  if ((ascii(0, 4) === 'II*\0') || (ascii(0, 4) === 'MM\0*')) return { mime: 'image/tiff', ext: '.tif' };
  return null;
}

const ETSY_OK = new Set(['image/jpeg', 'image/png', 'image/gif']);
export const isEtsyPicture = (kind) => !!kind && ETSY_OK.has(kind.mime);

const WORKER = fileURLToPath(new URL('./picture-worker.mjs', import.meta.url));
const MAX_INPUT = 40 * 1024 * 1024;

/** The memory this server may use: the container's own limit (Render's plan), or MEMORY_LIMIT_MB, or the machine's. */
export function memoryLimitBytes() {
  const env = Number(process.env.MEMORY_LIMIT_MB);
  if (env > 0) return env * 1024 * 1024;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const n = Number(fs.readFileSync(f, 'utf8').trim()); if (Number.isFinite(n) && n > 0 && n < 1e13) return n; } catch { /* not this layout */ }
  }
  return os.totalmem();
}

/** Width and height read from a WebP's header, without decoding it (null when it cannot be told). */
export function webpSize(b) {
  try {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
  } catch { /* short or odd file */ }
  return null;
}

/** What converting this picture will roughly need, in bytes (decoded pixels a few times over, plus the converter itself). */
export function conversionNeed(buffer, kind) {
  const dim = kind.mime === 'image/webp' ? webpSize(buffer) : null;
  const pixels = dim ? dim.w * dim.h : buffer.length * 10;
  return Math.round(pixels * 4 * 2.2 + 80 * 1024 * 1024);
}

// one conversion at a time: each one briefly needs a couple of hundred MB, and this server has little to spare
let lane = Promise.resolve();
const oneAtATime = (job) => { const run = lane.then(job, job); lane = run.catch(() => {}); return run; };

/** Run the conversion in its own process: if a picture is too big for the memory this server has, only that process dies. */
function convertInChild(buffer) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=160', WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('it took too long')); }, 60_000);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && out.length) return resolve(Buffer.concat(out));
      return reject(new Error(signal ? 'it is too large to convert here' : (err.trim().slice(0, 200) || `the converter stopped (${code})`)));
    });
    child.stdin.on('error', () => { /* the child ended early; close handles it */ });
    child.stdin.end(buffer);
  });
}

/**
 * Bytes that Etsy will take: JPEG, PNG and GIF pass through unchanged, everything else is converted (to JPEG, or to PNG
 * when the picture has see-through parts; very large ones are scaled to 4096 px on the long side).
 * Returns { buffer, mime, ext, converted, from }. `filename` (if given) comes back with the right extension.
 */
export async function forEtsy(buffer, filename = '') {
  const kind = pictureKind(buffer);
  if (!kind) throw badRequest('That file is not a picture (JPG, PNG, GIF or WebP).');
  const withExt = (ext) => (filename ? `${String(filename).replace(/\.[A-Za-z0-9_]+$/, '')}${ext}` : `image${ext}`);
  if (isEtsyPicture(kind)) return { buffer, mime: kind.mime, ext: kind.ext, filename: filename || `image${kind.ext}`, converted: false, from: kind.mime };
  if (buffer.length > MAX_INPUT) throw badRequest(`That ${kind.mime.replace('image/', '').toUpperCase()} picture is over 40 MB - too large to convert.`);

  // Never start what the server has no room for: say so, instead of letting the whole server fall over
  const need = conversionNeed(buffer, kind);
  const room = memoryLimitBytes() * 0.85 - process.memoryUsage().rss;
  if (need > room) {
    const mb = (n) => Math.max(0, Math.round(n / 1048576));
    throw badRequest(`That ${kind.mime.replace('image/', '').toUpperCase()} picture is too big to convert on this server (it would need about ${mb(need)} MB and ${mb(room)} MB are free). Save it as JPG or PNG and use + Upload.`);
  }

  let res;
  try { res = await oneAtATime(() => convertInChild(buffer)); } catch (err) {
    throw badRequest(`That ${kind.mime.replace('image/', '').toUpperCase()} picture could not be converted: ${err.message}. Save it as JPG or PNG and use + Upload.`);
  }
  const clear = res[0] === 'P'.charCodeAt(0);
  const ext = clear ? '.png' : '.jpg';
  return { buffer: res.subarray(1), mime: clear ? 'image/png' : 'image/jpeg', ext, filename: withExt(ext), converted: true, from: kind.mime };
}
