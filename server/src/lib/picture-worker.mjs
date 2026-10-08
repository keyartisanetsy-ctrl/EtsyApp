/**
 * Converts one picture to something Etsy takes. Runs as its own short-lived process (see picture.js) so that a huge
 * picture can only ever use up this process's memory, never the server's. Reads the picture from stdin; writes one
 * flag byte ('J' = JPEG, 'P' = PNG) followed by the converted bytes to stdout. Errors go to stderr with exit code 1.
 */
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(1);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);

try {
  // page 0 only: an animated WebP becomes its first frame; .rotate() applies the camera's orientation
  const base = () => sharp(input, { failOn: 'none', pages: 1, limitInputPixels: 36_000_000, sequentialRead: true }).rotate();
  const meta = await sharp(input, { failOn: 'none', pages: 1, limitInputPixels: 36_000_000 }).metadata();
  const clear = !!meta.hasAlpha;
  // Etsy shows pictures far smaller than this; capping the long side keeps tall supplier banners from eating memory
  const img = base().resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
  const out = clear
    ? await img.png({ compressionLevel: 9 }).toBuffer()
    : await img.jpeg({ quality: 92 }).toBuffer();
  process.stdout.write(Buffer.concat([Buffer.from(clear ? 'P' : 'J'), out]));
} catch (err) {
  process.stderr.write(String(err?.message ?? err));
  process.exit(1);
}
