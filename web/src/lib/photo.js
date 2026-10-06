/**
 * Photo work the packing desk does in the browser. A canvas opens every image
 * format, applies the rotation a phone photo carries, and needs no native
 * image library on the server - so the cutting and re-encoding live here, and
 * the server only stores what it is handed.
 */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The photo could not be opened.'));
    img.src = src;
  });
}

const toBlob = (canvas, quality = 0.92) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be saved.'))), 'image/jpeg', quality);
});

/**
 * A photo ready to keep and to show an AI: turned upright, no larger than
 * `maxSide` on its long edge, as a JPEG. Falls back to the file as it came if
 * the browser cannot open it, so adding an arrival never fails here.
 */
export async function normalizePhoto(file, { maxSide = 2000, quality = 0.9 } = {}) {
  let url;
  try {
    url = URL.createObjectURL(file);
    const img = await loadImage(url);
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // a transparent PNG would otherwise turn black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, quality);
    const base = String(file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

const GRID = 200;

/** Which cells of a GRID x GRID map of the photo no box covers (a cell counts when its centre is inside a box). */
function uncovered(regions) {
  const cells = new Uint8Array(GRID * GRID).fill(1);
  for (const r of regions) {
    for (let y = 0; y < GRID; y += 1) {
      const cy = (y + 0.5) / GRID;
      if (cy < r.y || cy >= r.y + r.h) continue;
      for (let x = 0; x < GRID; x += 1) {
        const cx = (x + 0.5) / GRID;
        if (cx >= r.x && cx < r.x + r.w) cells[y * GRID + x] = 0;
      }
    }
  }
  return cells;
}

/** Share of the photo (0-1) that no box covers - what would be left behind. */
export function leftoverShare(regions) {
  if (!regions.length) return 1;
  const cells = uncovered(regions);
  let n = 0;
  for (let i = 0; i < cells.length; i += 1) n += cells[i];
  return n / cells.length;
}

const FILL = '#808080';

/**
 * Cut the boxes out of a photo (boxes are fractions of its width and height).
 *
 * `crops` is one JPEG per box. `remainder` is the photo with those parts taken
 * out: when the boxes leave one clean rectangle - the usual "split it down the
 * middle" - the photo is simply cut down to it, the way a pair of scissors
 * would; otherwise the boxed parts are painted over with flat grey so the
 * products still in the photo stay where they were. `remainder` is null when
 * the boxes cover the whole photo.
 */
export async function splitPhoto(src, regions) {
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const rect = (r) => ({
    x: Math.min(W - 1, Math.round(r.x * W)),
    y: Math.min(H - 1, Math.round(r.y * H)),
    w: Math.max(1, Math.min(W, Math.round(r.w * W))),
    h: Math.max(1, Math.min(H, Math.round(r.h * H))),
  });

  const crops = [];
  for (const r of regions) {
    const b = rect(r);
    const canvas = document.createElement('canvas');
    canvas.width = b.w;
    canvas.height = b.h;
    canvas.getContext('2d').drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    // eslint-disable-next-line no-await-in-loop
    crops.push(await toBlob(canvas));
  }

  const cells = uncovered(regions);
  let minX = GRID; let minY = GRID; let maxX = -1; let maxY = -1;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (!cells[y * GRID + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { crops, remainder: null, trimmed: false };

  const tx = Math.floor((minX / GRID) * W);
  const ty = Math.floor((minY / GRID) * H);
  const tw = Math.min(W, Math.ceil(((maxX + 1) / GRID) * W)) - tx;
  const th = Math.min(H, Math.ceil(((maxY + 1) / GRID) * H)) - ty;
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, tx, ty, tw, th, 0, 0, tw, th);
  ctx.fillStyle = FILL;
  for (const r of regions) {
    const b = rect(r);
    ctx.fillRect(b.x - tx, b.y - ty, b.w, b.h);
  }
  return { crops, remainder: await toBlob(canvas), trimmed: tw < W || th < H };
}
