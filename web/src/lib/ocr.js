/**
 * Reading the words off a warehouse photo - brand names, model codes, Chinese
 * product names - in the browser, with no AI and no credits. The words go to
 * the server's free matcher (quickmatch.js), which weighs them against each
 * order item's own title, variation, SKU and supplier title.
 *
 * tesseract.js is loaded the first time it is needed (it and its language data
 * are a few MB, fetched once and then cached by the browser), runs one photo at
 * a time, and is never asked to be right: what it reads is only ever a hint.
 */

// The "fast" language models: small, quick, and plenty for printed packaging.
const LANG_PATH = 'https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0_fast';
const LANGS = ['eng', 'chi_sim'];
const MIN_CONFIDENCE = 55;

let workerPromise = null;
let queue = Promise.resolve();

async function startWorker() {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(LANGS, 1, { langPath: LANG_PATH, gzip: true });
  // Text is scattered over a photo of boxes, not laid out as a page.
  await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
  return worker;
}

/** Give up on something that never answers, so one stalled download cannot hold every photo behind it. */
const within = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} took too long`)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

let failure = null; // { at, error } - the last time the reader could not be started

async function getWorker() {
  // Offline or blocked CDN: say so at once for a minute instead of making every photo in a batch wait to fail.
  if (!workerPromise && failure && Date.now() - failure.at < 60_000) throw failure.error;
  if (!workerPromise) {
    // The reader and its language files come from a CDN; one dropped download should not cost the photo its text.
    const attempt = () => within(startWorker(), 60_000, 'Loading the text reader');
    workerPromise = attempt().catch(() => attempt()).catch((err) => { workerPromise = null; failure = { at: Date.now(), error: err }; throw err; });
  }
  return workerPromise;
}

/** Throw the reader away (it is stuck or broken); the next photo starts a fresh one. */
async function dropWorker() {
  const pending = workerPromise;
  workerPromise = null;
  try { (await pending)?.terminate?.(); } catch { /* already gone */ }
}

/** The words of a recognition result that the engine was reasonably sure about. */
function confidentWords(data) {
  const out = [];
  for (const block of data?.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = String(word.text ?? '').trim();
          if (text && word.confidence >= MIN_CONFIDENCE) out.push(text);
        }
      }
    }
  }
  return out;
}

/**
 * The text on a picture (a URL, File or Blob). Resolves to '' when nothing
 * readable is there, and rejects when the reader itself cannot load (offline,
 * a blocked CDN) - the caller decides how loudly to say so.
 */
export function readPhotoText(source) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    let image = source;
    if (typeof source === 'string') {
      const res = await fetch(source, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('The photo could not be fetched for reading.');
      image = await res.blob();
    }
    let data;
    try {
      ({ data } = await within(worker.recognize(image, {}, { blocks: true }), 60_000, 'Reading the photo'));
    } catch (err) { await dropWorker(); throw err; }
    const words = confidentWords(data);
    return (words.length ? words.join(' ') : '').replace(/\s+/g, ' ').trim();
  });
  // One failure must not stop the photos behind it.
  queue = job.catch(() => undefined);
  return job;
}
