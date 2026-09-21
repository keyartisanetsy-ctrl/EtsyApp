/**
 * Canned buyer messages.
 *
 * Etsy's public API has no endpoint for a third-party app to send a message
 * to a buyer - that door has been closed to ordinary developer keys since
 * 2018. The next best thing this app can do is keep the wording ready and
 * rendered with the order's own details, one click from the clipboard, for
 * the two moments a seller actually wants to say something: right after the
 * order is pushed to Airtable, and once the parcel is marked delivered.
 */
import { getDb } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getOrder } from './orders.js';

export const KINDS = ['airtable_pushed', 'delivered'];

const shape = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  body: row.body,
  isDefault: !!row.is_default,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listTemplates(kind) {
  const db = getDb();
  return (kind
    ? db.prepare('SELECT * FROM message_templates WHERE kind = ? ORDER BY is_default DESC, name').all(kind)
    : db.prepare('SELECT * FROM message_templates ORDER BY kind, is_default DESC, name').all()
  ).map(shape);
}

export function getTemplate(id) {
  const row = getDb().prepare('SELECT * FROM message_templates WHERE id = ?').get(id);
  if (!row) throw notFound(`Message template ${id} does not exist.`);
  return shape(row);
}

export function getDefaultTemplate(kind) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM message_templates WHERE kind = ? AND is_default = 1 ORDER BY id LIMIT 1').get(kind)
    ?? db.prepare('SELECT * FROM message_templates WHERE kind = ? ORDER BY id LIMIT 1').get(kind);
  return row ? shape(row) : null;
}

export function saveTemplate({ id = null, name, kind, body, isDefault = false } = {}) {
  const db = getDb();
  if (!name?.trim()) throw badRequest('Give the template a name.');
  if (!body?.trim()) throw badRequest('The message cannot be empty.');
  if (!KINDS.includes(kind)) throw badRequest(`Unknown template kind "${kind}".`);

  return db.transaction(() => {
    if (isDefault) db.prepare('UPDATE message_templates SET is_default = 0 WHERE kind = ?').run(kind);
    if (id) {
      const existing = db.prepare('SELECT id FROM message_templates WHERE id = ?').get(id);
      if (!existing) throw notFound(`Message template ${id} does not exist.`);
      db.prepare(`UPDATE message_templates SET name = ?, kind = ?, body = ?, is_default = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name.trim(), kind, body, isDefault ? 1 : 0, id);
      return getTemplate(id);
    }
    const info = db.prepare('INSERT INTO message_templates (name, kind, body, is_default) VALUES (?,?,?,?)')
      .run(name.trim(), kind, body, isDefault ? 1 : 0);
    return getTemplate(info.lastInsertRowid);
  })();
}

export function setDefaultTemplate(id) {
  const t = getTemplate(id);
  getDb().transaction(() => {
    getDb().prepare('UPDATE message_templates SET is_default = 0 WHERE kind = ?').run(t.kind);
    getDb().prepare('UPDATE message_templates SET is_default = 1 WHERE id = ?').run(id);
  })();
  return getTemplate(id);
}

export function deleteTemplate(id) {
  const db = getDb();
  const t = getTemplate(id);
  let promoted = null;
  db.transaction(() => {
    db.prepare('DELETE FROM message_templates WHERE id = ?').run(id);
    if (t.isDefault) {
      const next = db.prepare('SELECT id FROM message_templates WHERE kind = ? ORDER BY id LIMIT 1').get(t.kind);
      if (next) { db.prepare('UPDATE message_templates SET is_default = 1 WHERE id = ?').run(next.id); promoted = next.id; }
    }
  })();
  return { deleted: id, promotedToDefault: promoted };
}

/** {placeholder} -> the order's own value. Unknown placeholders are left as-is. */
export function renderTemplate(body, order) {
  const values = {
    buyerName: order.name || 'there',
    orderNumber: String(order.receiptId),
    shopName: order.shopName || '',
    trackingCode: order.shipments?.[0]?.trackingCode || '',
    carrier: order.shipments?.[0]?.carrier || '',
  };
  return body.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

/** The rendered default template for one order, ready to copy. */
export function previewFor(receiptId, kind) {
  const template = getDefaultTemplate(kind);
  if (!template) throw notFound(`No "${kind}" message template is set up yet.`);
  const order = getOrder(receiptId);
  const db = getDb();
  const shop = db.prepare('SELECT shop_name FROM etsy_accounts WHERE shop_id IS ?').get(activeShopId());
  return {
    templateId: template.id,
    templateName: template.name,
    receiptId,
    text: renderTemplate(template.body, { ...order, shopName: shop?.shop_name || '' }),
  };
}
