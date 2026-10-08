import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import { asyncRoute, bool, required } from '../lib/http.js';
import * as drafts from '../services/drafts.js';
import * as draftmedia from '../services/draftmedia.js';
import * as imageedit from '../services/imageedit.js';
import * as listings from '../services/listings.js';
import { getDb } from '../db/index.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Everything on the desk. */
router.get('/', asyncRoute(async (req, res) => {
  res.json({ drafts: drafts.list({ includePushed: bool(req.query.includePushed) }), editable: drafts.EDITABLE });
}));

/** Bring down whatever Etsy has in draft. */
router.post('/pull', asyncRoute(async (req, res) => {
  res.json(await drafts.pullFromEtsy({ includeInactive: bool(req.body?.includeInactive) }));
}));

/**
 * The shipping profiles, processing profiles, sections and return policies this
 * shop actually has, so those fields are lists rather than numbers to look up.
 */
router.get('/choices', asyncRoute(async (req, res) => res.json(await drafts.shopChoices())));

/** Make a processing profile, for a shop that has none yet. */
router.post('/choices/processing-profile', asyncRoute(async (req, res) => {
  res.status(201).json(await drafts.createProcessingProfile(req.body ?? {}));
}));

/**
 * What "Fill without AI" (and the defaultable part of "Fill with AI") fill
 * in first, before guessing at anything: this shop's own usual category,
 * materials, who/when-made, shipping/return/section and settings. Ahead of
 * the /:id routes so "defaults" is never swallowed as a listing id.
 */
router.get('/defaults', asyncRoute(async (req, res) => res.json(drafts.getDraftDefaults())));
router.put('/defaults', asyncRoute(async (req, res) => res.json(drafts.setDraftDefaults(req.body ?? {}))));

/** Start one here. Etsy sees nothing until it is pushed. */
router.post('/', asyncRoute(async (req, res) => res.json(drafts.createLocal(req.body ?? {}))));

/** Delete drafts: off the desk, and - only when asked, and only for ones Etsy still has as drafts - on Etsy too. */
router.post('/delete', asyncRoute(async (req, res) => {
  res.json(await drafts.removeMany(req.body?.ids ?? [], { alsoOnEtsy: bool(req.body?.alsoOnEtsy) }));
}));

// -------------------------------------------------- AI edits of a picture
/** Providers and models on offer, and what the box starts with. */
router.get('/image-edit/options', asyncRoute(async (req, res) => res.json(imageedit.options())));
router.get('/image-edit/jobs/:jobId', asyncRoute(async (req, res) => res.json(imageedit.job(req.params.jobId))));
router.get('/image-edit/jobs/:jobId/file', asyncRoute(async (req, res) => {
  const { path, mime } = imageedit.jobFile(req.params.jobId);
  res.type(mime).send(fs.readFileSync(path));
}));
router.post('/image-edit/jobs/:jobId/apply', asyncRoute(async (req, res) => res.json(await imageedit.apply(req.params.jobId, { mode: req.body?.mode }))));
router.delete('/image-edit/jobs/:jobId', asyncRoute(async (req, res) => res.json(imageedit.discard(req.params.jobId))));

router.get('/:id', asyncRoute(async (req, res) => res.json(drafts.get(Number(req.params.id)))));

/** Stage an edit. Send a field as null to drop your change and go back to Etsy's value. */
router.patch('/:id', asyncRoute(async (req, res) => res.json(drafts.stage(Number(req.params.id), req.body ?? {}))));

/** What pushing would do, and anything that would stop it. */
router.get('/:id/preview', asyncRoute(async (req, res) => res.json(drafts.preview(Number(req.params.id)))));

/**
 * One button: fill in whatever this draft is still missing (materials,
 * category, tags...) from what it already says about itself. Only ever
 * stages the gaps -- nothing already filled in is touched. { useAI: false }
 * fills with plain lookups instead of calling the AI -- free, but cannot
 * write a description.
 */
router.post('/:id/autofill', asyncRoute(async (req, res) => {
  res.json(await drafts.autofillMissing(Number(req.params.id), { useAI: req.body?.useAI !== false }));
}));

/** Send it to Etsy. */
router.post('/:id/push', asyncRoute(async (req, res) => {
  res.json(await drafts.push(Number(req.params.id), { activate: bool(req.body?.activate) }));
}));

/** Pull this one draft's photos/video back in step, right after adding one from here. */
router.post('/:id/resync', asyncRoute(async (req, res) => res.json(await drafts.refreshSnapshot(Number(req.params.id)))));

router.post('/:id/revert', asyncRoute(async (req, res) => res.json(drafts.revert(Number(req.params.id)))));
router.delete('/:id', asyncRoute(async (req, res) => res.json(drafts.remove(Number(req.params.id)))));

// ------------------------------------------------------------------ media
//
// Only meaningful for a local-only draft (a negative id): Etsy's own upload
// endpoints need a real listing_id, which does not exist until this draft is
// pushed, so a photo/video added before that is staged here and uploaded the
// moment it does. A draft that already is a real Etsy listing manages its
// photos through /api/listings/:id/images and /videos instead, immediately.

router.get('/:id/media', asyncRoute(async (req, res) => res.json(draftmedia.list(Number(req.params.id)))));

/**
 * Add by pasting a link. A picture is downloaded and kept by this app (so it carries on under this site's own
 * address, whatever happens to the link, and it is this copy that goes to Etsy); a video stays a link.
 * On a draft that is already a real Etsy listing the picture goes straight to Etsy.
 */
router.post('/:id/media', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['kind', 'url']);
  const id = Number(req.params.id);
  if (b.kind === 'image' && id > 0) {
    const pic = await draftmedia.fetchPicture(b.url);
    const have = getDb().prepare('SELECT COUNT(*) c FROM listing_images WHERE listing_id = ?').get(id).c;
    if (have >= draftmedia.MAX_IMAGES) throw new Error(`Etsy allows up to ${draftmedia.MAX_IMAGES} images on a listing, and this one already has ${have}.`);
    await listings.uploadImage(id, { buffer: pic.buffer, filename: pic.filename, mime: pic.mime, rank: have + 1, altText: b.altText });
    await drafts.refreshSnapshot(id);
    res.status(201).json({ uploaded: true });
    return;
  }
  if (b.kind === 'image') { res.status(201).json(await draftmedia.addImageFromUrl(id, b.url, b.altText)); return; }
  res.status(201).json(draftmedia.addUrl(id, { kind: b.kind, url: b.url, altText: b.altText }));
}));

/** Start an AI edit of one picture (translate the words on it, or whatever the instruction says). */
router.post('/:id/media/:mediaId/ai-edit', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.status(202).json(await imageedit.start({
    listingId: Number(req.params.id), mediaId: Number(req.params.mediaId),
    provider: b.provider, model: b.model, prompt: b.prompt, remember: b.remember !== false,
  }));
}));

/** Add by uploading a file from this machine. */
router.post('/:id/media/upload', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('Attach a file as the "file" field.');
  const kind = req.body?.kind === 'video' ? 'video' : 'image';
  res.status(201).json(draftmedia.addUpload(Number(req.params.id), {
    kind, buffer: req.file.buffer, filename: req.file.originalname, mime: req.file.mimetype, altText: req.body?.altText,
  }));
}));

router.get('/:id/media/:mediaId/file', asyncRoute(async (req, res) => {
  const { path, mime } = draftmedia.fileFor(Number(req.params.id), Number(req.params.mediaId));
  res.type(mime).send(fs.readFileSync(path));
}));

router.post('/:id/media/:mediaId/move', asyncRoute(async (req, res) => {
  res.json(draftmedia.move(Number(req.params.id), Number(req.params.mediaId), req.body?.direction === 'down' ? 'down' : 'up'));
}));

router.delete('/:id/media/:mediaId', asyncRoute(async (req, res) => {
  res.json(draftmedia.remove(Number(req.params.id), Number(req.params.mediaId)));
}));

export default router;
