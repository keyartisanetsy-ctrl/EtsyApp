import { Router } from 'express';
import multer from 'multer';
import { asyncRoute, int, bool, list, tri, required } from '../lib/http.js';
import * as listings from '../services/listings.js';
import * as sync from '../services/sync.js';
import { call } from '../etsy/client.js';
import { requireShopId } from '../etsy/shop.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get('/', asyncRoute(async (req, res) => {
  res.json(listings.localListings({
    search: req.query.search ?? '',
    state: req.query.state ?? '',
    sectionId: int(req.query.sectionId),
    missingTags: bool(req.query.missingTags),
    missingImages: bool(req.query.missingImages),
    sort: req.query.sort ?? 'updated',
    dir: req.query.dir ?? 'desc',
    limit: int(req.query.limit, 100),
    offset: int(req.query.offset, 0),
  }));
}));

router.get('/meta', asyncRoute(async (req, res) => {
  res.json({
    states: listings.LISTING_STATES,
    settableStates: listings.SETTABLE_STATES,
    whoMade: listings.WHO_MADE,
    whenMade: listings.WHEN_MADE,
    types: listings.LISTING_TYPES,
  });
}));

router.post('/', asyncRoute(async (req, res) => res.status(201).json(await listings.createDraft(req.body ?? {}))));

router.get('/:id', asyncRoute(async (req, res) => res.json(listings.localListing(Number(req.params.id)))));

router.post('/:id/refresh', asyncRoute(async (req, res) => res.json(await listings.refreshListing(Number(req.params.id)))));

router.patch('/:id', asyncRoute(async (req, res) => {
  res.json(await listings.updateListing(Number(req.params.id), req.body ?? {}, { dryRun: bool(req.query.dryRun) }));
}));

router.post('/:id/state', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['state']);
  res.json(await listings.setState(Number(req.params.id), req.body.state));
}));

router.delete('/:id', asyncRoute(async (req, res) => res.json(await listings.deleteListing(Number(req.params.id)))));

// ------------------------------------------------------------------ images

router.get('/:id/images', asyncRoute(async (req, res) => res.json(await listings.refreshImages(Number(req.params.id)))));

router.post('/:id/images', upload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) throw new Error('Attach an image file as the "image" field.');
  res.status(201).json(await listings.uploadImage(Number(req.params.id), {
    buffer: req.file.buffer,
    filename: req.file.originalname,
    mime: req.file.mimetype,
    rank: int(req.body.rank, 1),
    altText: req.body.altText,
    overwrite: bool(req.body.overwrite),
    isWatermarked: bool(req.body.isWatermarked),
  }));
}));

router.delete('/:id/images/:imageId', asyncRoute(async (req, res) => {
  res.json(await listings.deleteImage(Number(req.params.id), Number(req.params.imageId)));
}));

router.get('/:id/variation-images', asyncRoute(async (req, res) => {
  res.json(await call('getListingVariationImages', { shop_id: requireShopId(), listing_id: Number(req.params.id) }));
}));

router.post('/:id/variation-images', asyncRoute(async (req, res) => {
  required(req.body ?? {}, ['pairs']);
  res.json(await listings.setVariationImages(Number(req.params.id), req.body.pairs));
}));

// ---------------------------------------------------------- videos & files

router.post('/:id/videos', upload.single('video'), asyncRoute(async (req, res) => {
  res.status(201).json(await listings.uploadVideo(Number(req.params.id), {
    buffer: req.file.buffer, filename: req.file.originalname, mime: req.file.mimetype, name: req.body.name,
  }));
}));

router.delete('/:id/videos/:videoId', asyncRoute(async (req, res) => {
  res.json(await listings.deleteVideo(Number(req.params.id), Number(req.params.videoId)));
}));

router.get('/:id/files', asyncRoute(async (req, res) => res.json(await listings.listFiles(Number(req.params.id)))));

router.post('/:id/files', upload.single('file'), asyncRoute(async (req, res) => {
  res.status(201).json(await listings.uploadDigitalFile(Number(req.params.id), {
    buffer: req.file.buffer, filename: req.file.originalname, name: req.body.name, rank: int(req.body.rank, 1),
  }));
}));

router.delete('/:id/files/:fileId', asyncRoute(async (req, res) => {
  res.json(await listings.deleteFile(Number(req.params.id), Number(req.params.fileId)));
}));

// ------------------------------------------- personalisation / translations

router.post('/:id/personalization', asyncRoute(async (req, res) => {
  res.json(await listings.setPersonalization(Number(req.params.id), req.body ?? {}));
}));

router.delete('/:id/personalization', asyncRoute(async (req, res) => {
  res.json(await listings.removePersonalization(Number(req.params.id)));
}));

router.get('/:id/translations/:language', asyncRoute(async (req, res) => {
  res.json(await listings.getTranslation(Number(req.params.id), req.params.language));
}));

router.put('/:id/translations/:language', asyncRoute(async (req, res) => {
  res.json(await listings.upsertTranslation(Number(req.params.id), req.params.language, req.body ?? {}));
}));

// ------------------------------------------------------------- properties

router.get('/:id/properties', asyncRoute(async (req, res) => res.json(await listings.listProperties(Number(req.params.id)))));

router.put('/:id/properties/:propertyId', asyncRoute(async (req, res) => {
  res.json(await listings.setProperty(Number(req.params.id), Number(req.params.propertyId), req.body ?? {}));
}));

router.delete('/:id/properties/:propertyId', asyncRoute(async (req, res) => {
  res.json(await listings.deleteProperty(Number(req.params.id), Number(req.params.propertyId)));
}));

export default router;
