import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import config from '../config.js';
import { asyncRoute, int, bool, list, required } from '../lib/http.js';
import { getDb } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import * as ai from '../services/ai/index.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------------------------------------------------------- prompt library

router.get('/prompts', asyncRoute(async (req, res) => {
  res.json({ kinds: ai.PROMPT_KINDS, prompts: ai.listPrompts(req.query.kind) });
}));

router.get('/prompts/default/:kind', asyncRoute(async (req, res) => res.json(ai.getDefaultPrompt(req.params.kind))));

router.post('/prompts', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['name', 'kind', 'body']);
  res.status(201).json(ai.savePrompt({ name: b.name, kind: b.kind, body: b.body, isDefault: !!b.isDefault }));
}));

router.put('/prompts/:id', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['name', 'kind', 'body']);
  res.json(ai.savePrompt({ id: Number(req.params.id), name: b.name, kind: b.kind, body: b.body, isDefault: !!b.isDefault }));
}));

router.post('/prompts/:id/default', asyncRoute(async (req, res) => res.json(ai.setDefaultPrompt(Number(req.params.id)))));

router.delete('/prompts/:id', asyncRoute(async (req, res) => res.json(ai.deletePrompt(Number(req.params.id)))));

// ------------------------------------------------------------- attachments

/** Screenshots of buyer messages, or source photos for listing generation. */
router.post('/attachments', upload.array('files', 20), asyncRoute(async (req, res) => {
  if (!req.files?.length) throw new Error('Attach at least one file as "files".');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = getDb();
  const saved = [];

  for (const file of req.files) {
    const id = `att_${crypto.randomBytes(8).toString('hex')}`;
    const ext = path.extname(file.originalname) || '.png';
    const dest = path.join(config.uploadDir, `${id}${ext}`);
    fs.writeFileSync(dest, file.buffer);
    db.prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
      .run(id, file.originalname, file.mimetype, file.size, dest, sha256(file.buffer), req.body.purpose ?? 'reply-screenshot');
    saved.push({ id, filename: file.originalname, mime: file.mimetype, size: file.size, url: `/api/ai/attachments/${id}` });
  }
  res.status(201).json({ attachments: saved });
}));

router.get('/attachments/:id', asyncRoute(async (req, res) => {
  const a = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!a || !fs.existsSync(a.path)) return res.status(404).json({ error: 'Attachment not found' });
  res.type(a.mime || 'application/octet-stream').send(fs.readFileSync(a.path));
}));

router.delete('/attachments/:id', asyncRoute(async (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (a) { try { fs.unlinkSync(a.path); } catch { /* already gone */ } db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id); }
  res.json({ deleted: req.params.id });
}));

// ------------------------------------------------------------------ status

router.get('/status', asyncRoute(async (req, res) => res.json(ai.providerStatus())));

router.get('/runs', asyncRoute(async (req, res) => res.json(ai.listRuns(req.query.kind, int(req.query.limit, 50)))));

router.get('/runs/:id', asyncRoute(async (req, res) => res.json(ai.getRun(Number(req.params.id)))));

// ------------------------------------------------------------ reply studio

/**
 * Draft a customer reply. The buyer message can be typed, taken from an
 * order, or read out of an uploaded screenshot.
 */
router.post('/reply', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await ai.draftReply({
    message: b.message ?? '',
    attachmentIds: list(b.attachmentIds),
    promptId: b.promptId ? Number(b.promptId) : undefined,
    promptOverride: b.promptOverride,
    provider: b.provider,
    tone: b.tone ?? '',
    orderId: b.orderId ? Number(b.orderId) : null,
    extraContext: b.extraContext ?? '',
  }));
}));

// ---------------------------------------------------------- listing writers

router.post('/title', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  const out = await ai.writeTitle(b.product ?? b, b);
  res.json({ ...out, options: ai.parseTitleOptions(out.text) });
}));

router.post('/description', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await ai.writeDescription(b.product ?? b, b));
}));

router.post('/tags', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  const out = await ai.writeTags(b.product ?? b, b);
  res.json({ ...out, tags: ai.normaliseTags(out.text) });
}));

/** Whole listing from product notes, returned as structured JSON. */
router.post('/listing', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await ai.writeListing(b.product ?? b, b));
}));

/** Free-form run against any prompt kind. */
router.post('/run', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  required(b, ['kind']);
  res.json(await ai.run({
    kind: b.kind,
    provider: b.provider,
    promptId: b.promptId ? Number(b.promptId) : null,
    promptOverride: b.promptOverride,
    userInput: b.input ?? b.userInput ?? '',
    attachmentIds: list(b.attachmentIds),
    context: b.context ?? null,
    maxTokens: int(b.maxTokens, 4096),
  }));
}));

// -------------------------------------------------------------- image edit

router.post('/image', upload.single('image'), asyncRoute(async (req, res) => {
  const prompt = req.body.prompt || ai.getDefaultPrompt('image')?.body;
  if (!prompt) throw new Error('Give an editing instruction, or create a default "image" prompt.');

  const result = await ai.editImage({
    prompt,
    size: req.body.size || '1024x1024',
    image: req.file ? { buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname } : null,
  });

  // Persist the result so it can be pushed straight onto a listing.
  let attachment = null;
  if (result.b64) {
    const id = `att_${crypto.randomBytes(8).toString('hex')}`;
    const dest = path.join(config.uploadDir, `${id}.png`);
    const buf = Buffer.from(result.b64, 'base64');
    fs.writeFileSync(dest, buf);
    getDb().prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
      .run(id, `${id}.png`, 'image/png', buf.length, dest, sha256(buf), 'ai-output');
    attachment = { id, url: `/api/ai/attachments/${id}`, bytes: buf.length };
  }
  res.json({
    attachment,
    url: result.url ?? null,
    producedSize: result.producedSize,
    requestedSize: result.requestedSize,
    needsResize: !!result.needsResize,
  });
}));

/**
 * The same thing for a batch: up to 20 photos edited with one instruction.
 *
 * Run one at a time on purpose. Twenty image requests fired together get
 * rate-limited, and one failure in the middle of a parallel burst leaves you
 * guessing which photo it was. Sequentially, every source keeps its own result
 * or its own error, and a failure part-way through still returns everything
 * finished before it.
 */
router.post('/image/batch', upload.array('images', 20), asyncRoute(async (req, res) => {
  const prompt = req.body.prompt || ai.getDefaultPrompt('image')?.body;
  if (!prompt) throw new Error('Give an editing instruction, or create a default "image" prompt.');

  const files = req.files ?? [];
  const variants = Math.min(Math.max(1, Number(req.body.variants) || 1), 20);
  const size = req.body.size || '1024x1024';

  // Nothing attached means "generate from scratch", and then `variants` is how
  // many pictures to make rather than how many per photo.
  const jobs = files.length
    ? files.map((f, i) => ({ index: i, filename: f.originalname, image: { buffer: f.buffer, mime: f.mimetype, filename: f.originalname } }))
    : Array.from({ length: variants }, (unused, i) => ({ index: i, filename: `generated ${i + 1}`, image: null }));

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const db = getDb();
  const results = [];

  const store = (b64) => {
    const id = `att_${crypto.randomBytes(8).toString('hex')}`;
    const dest = path.join(config.uploadDir, `${id}.png`);
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(dest, buf);
    db.prepare('INSERT INTO attachments (id, filename, mime, size_bytes, path, sha256, purpose) VALUES (?,?,?,?,?,?,?)')
      .run(id, `${id}.png`, 'image/png', buf.length, dest, sha256(buf), 'ai-output');
    return { id, url: `/api/ai/attachments/${id}`, bytes: buf.length };
  };

  for (const job of jobs) {
    try {
      const out = await ai.editImage({
        prompt,
        size,
        image: job.image,
        n: files.length ? variants : 1,
      });
      results.push({
        index: job.index,
        filename: job.filename,
        attachments: (out.images ?? []).filter((i) => i.b64).map((i) => store(i.b64)),
        producedSize: out.producedSize,
        requestedSize: out.requestedSize,
        needsResize: !!out.needsResize,
      });
    } catch (err) {
      results.push({ index: job.index, filename: job.filename, attachments: [], error: err.message });
    }
  }

  res.json({
    requested: jobs.length,
    done: results.filter((r) => r.attachments.length).length,
    failed: results.filter((r) => r.error).length,
    results,
  });
}));

export default router;
