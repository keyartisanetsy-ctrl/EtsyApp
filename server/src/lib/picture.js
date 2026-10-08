/**
 * Pictures on their way to Etsy.
 *
 * Etsy takes JPEG, PNG and GIF. Shops and AI tools hand out WebP (and sometimes AVIF, TIFF, BMP) all the time - the
 * address ends in .jpg and the server still answers with WebP - so anything else is converted here, once, on the way in:
 * to JPEG, or to PNG when the picture has see-through parts. The picture itself is not touched beyond that.
 */
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

let sharpLoaded;
async function loadSharp() {
  if (sharpLoaded === undefined) {
    try { sharpLoaded = (await import('sharp')).default; } catch { sharpLoaded = null; }
  }
  return sharpLoaded;
}

/**
 * Bytes that Etsy will take: JPEG, PNG and GIF pass through unchanged, everything else is converted.
 * Returns { buffer, mime, ext, converted, from }. `filename` (if given) comes back with the right extension.
 */
export async function forEtsy(buffer, filename = '') {
  const kind = pictureKind(buffer);
  if (!kind) throw badRequest('That file is not a picture (JPG, PNG, GIF or WebP).');
  const withExt = (ext) => (filename ? `${String(filename).replace(/\.[A-Za-z0-9_]+$/, '')}${ext}` : `image${ext}`);
  if (isEtsyPicture(kind)) return { buffer, mime: kind.mime, ext: kind.ext, filename: filename || `image${kind.ext}`, converted: false, from: kind.mime };

  const sharp = await loadSharp();
  if (!sharp) throw badRequest(`This server cannot convert ${kind.mime.replace('image/', '').toUpperCase()} pictures (the image library is missing). Save it as JPG or PNG first.`);
  try {
    // page 0 only: an animated WebP becomes its first frame
    const img = sharp(buffer, { failOn: 'none', pages: 1 }).rotate();   // .rotate() applies the camera's orientation
    const meta = await img.metadata();
    const clear = !!meta.hasAlpha;
    const out = clear
      ? await img.png({ compressionLevel: 9 }).toBuffer()
      : await img.flatten({ background: '#ffffff' }).jpeg({ quality: 93, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    const ext = clear ? '.png' : '.jpg';
    return { buffer: out, mime: clear ? 'image/png' : 'image/jpeg', ext, filename: withExt(ext), converted: true, from: kind.mime };
  } catch (err) {
    throw badRequest(`That ${kind.mime.replace('image/', '').toUpperCase()} picture could not be converted: ${err.message}`);
  }
}
