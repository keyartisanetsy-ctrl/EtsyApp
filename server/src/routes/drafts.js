import { Router } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import { asyncRoute, bool, required } from '../lib/http.js';
import * as drafts from '../services/drafts.js';
import * as draftmedia from '../services/draftmedia.js';

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

/** Start one here. Etsy sees nothing until it is pushed. */
router.post('/', asyncRoute(async (req, res) => res.json(drafts.createLocal(req.body ?? {}))));

router.get('/:id', asyncRoute(async (req, res) => res.json(drafts.get(Number(req.params.id)))));

/** Stage an edit. Send a field as null to drop your change and go back to Etsy's value. */
router.patch('/:id', asyncRoute(async (req, res) => res.json(drafts.stage(Number(req.params.id), req.body ?? {}))));

/** What pushing would do, and anything that would stop it. */
router.get('/:id/preview', asyncRoute(async (req, res) => res.json(drafts.preview(Number(req.params.id)))));

/**
 * One button: fill in whatever this draft is still missing (materials,
 * category, tags...) from what it already says about itself. Only ever
 * stages the gaps -- nothing already filled in is touched.
 */
router.post('/:id/autofill', asyncRoute(async (req, res) => res.json(await drafts.autofillMissing(Number(req.params.id)))));

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

/** Add by pasting a public URL (what Product Studio's own images arrive as). */
router.post('/:id/media', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['kind', 'url']);
  res.status(201).json(draftmedia.addUrl(Number(req.params.id), { kind: b.kind, url: b.url, altText: b.altText }));
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
