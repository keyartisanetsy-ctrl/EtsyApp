/**
 * Airtable destinations and the push engine.
 *
 * A destination is "these orders, mapped this way, into that table". It belongs
 * to one shop (or to every shop when shop_id is NULL), so switching shops
 * switches which destinations you see, like every other screen in this app.
 *
 * Pushing is idempotent by design: each pushed row remembers the Airtable
 * record it became, and the default mode upserts on a key column, so pressing
 * the button twice updates the same row instead of creating a second one.
 */
import { getDb } from '../db/index.js';
import { activeShopId, currentShop } from '../etsy/shop.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as at from '../airtable/client.js';
import { loadRows, resolveSource, SOURCE_FIELDS, isOrderLevel } from '../airtable/fields.js';
import { matchByName, matchByAi, suggestMergeFields } from '../airtable/mapping.js';
import { ensureRates } from './fx.js';
import { syncForReceipts } from './variantimages.js';
import { enrichReceiptContacts } from './sync.js';

const log = createLogger('airtable');

const parse = (json, fallback) => { try { return JSON.parse(json ?? ''); } catch { return fallback; } };

const shape = (row) => (row ? {
  id: row.id,
  shopId: row.shop_id,
  label: row.label,
  baseId: row.base_id,
  baseName: row.base_name,
  tableId: row.table_id,
  tableName: row.table_name,
  viewId: row.view_id,
  viewName: row.view_name,
  channel: row.channel || 'etsy',
  rowMode: row.row_mode || 'item',
  matchMode: row.match_mode || 'name',
  fieldMap: parse(row.field_map, []),
  mergeFields: parse(row.merge_fields, []),
  constants: parse(row.constants, {}),
  createOptions: !!row.create_options,
  createLinks: !!row.create_links,
  sendEmpty: !!row.send_empty,
  oncePerOrder: row.once_per_order === null || row.once_per_order === undefined ? true : !!row.once_per_order,
  isDefault: !!row.is_default,
  lastPushAt: row.last_push_at,
  createdAt: row.created_at,
} : null);

// ------------------------------------------------------------ destinations

export function listDestinations() {
  const shopId = activeShopId();
  return getDb().prepare(`
    SELECT * FROM airtable_destinations
    WHERE shop_id IS ? OR shop_id IS NULL
    ORDER BY is_default DESC, id`).all(shopId).map(shape);
}

export function getDestination(id) {
  const row = getDb().prepare('SELECT * FROM airtable_destinations WHERE id = ?').get(id);
  if (!row) throw notFound(`Airtable destination ${id} does not exist.`);
  return shape(row);
}

export function defaultDestination(channel = 'etsy') {
  const list = listDestinations().filter((d) => d.channel === channel);
  const fallback = listDestinations();
  return list.find((d) => d.isDefault) ?? list[0] ?? fallback.find((d) => d.isDefault) ?? fallback[0] ?? null;
}

export function saveDestination(input = {}) {
  const db = getDb();
  const {
    id = null, label, baseId, baseName = null, tableId, tableName = null,
    viewId = null, viewName = null, channel = 'etsy', rowMode = 'item', matchMode = 'name',
    fieldMap = [], mergeFields = [], constants = {},
    createOptions = true, createLinks = false, sendEmpty = false, oncePerOrder = true,
    isDefault = false, allShops = false,
  } = input;

  if (!label?.trim()) throw badRequest('Give the destination a name so you can tell them apart.');
  if (!baseId || !tableId) throw badRequest('Pick an Airtable base and table.');
  if (!['item', 'order'].includes(rowMode)) throw badRequest('rowMode must be "item" or "order".');
  if (!['etsy', 'shopify'].includes(channel)) throw badRequest('channel must be "etsy" or "shopify".');
  if (mergeFields.length > 3) throw badRequest('Airtable can match on at most three columns.');

  const shopId = allShops ? null : activeShopId();
  const args = {
    shop_id: shopId,
    label: label.trim(),
    base_id: baseId,
    base_name: baseName,
    table_id: tableId,
    table_name: tableName,
    view_id: viewId,
    view_name: viewName,
    channel,
    row_mode: rowMode,
    match_mode: matchMode,
    field_map: JSON.stringify(fieldMap),
    merge_fields: JSON.stringify(mergeFields),
    constants: JSON.stringify(constants),
    create_options: createOptions ? 1 : 0,
    create_links: createLinks ? 1 : 0,
    send_empty: sendEmpty ? 1 : 0,
    once_per_order: oncePerOrder ? 1 : 0,
    is_default: isDefault ? 1 : 0,
  };

  let destId = id;
  if (id) {
    db.prepare(`
      UPDATE airtable_destinations SET
        shop_id = @shop_id,
        label = @label, base_id = @base_id, base_name = @base_name, table_id = @table_id, table_name = @table_name,
        view_id = @view_id, view_name = @view_name, channel = @channel, row_mode = @row_mode, match_mode = @match_mode,
        field_map = @field_map, merge_fields = @merge_fields, constants = @constants,
        create_options = @create_options, create_links = @create_links, send_empty = @send_empty,
        once_per_order = @once_per_order,
        is_default = @is_default, updated_at = datetime('now')
      WHERE id = @id`).run({ ...args, id });
  } else {
    const res = db.prepare(`
      INSERT INTO airtable_destinations
        (shop_id, label, base_id, base_name, table_id, table_name, view_id, view_name, channel, row_mode, match_mode,
         field_map, merge_fields, constants, create_options, create_links, send_empty, once_per_order, is_default)
      VALUES (@shop_id, @label, @base_id, @base_name, @table_id, @table_name, @view_id, @view_name, @channel, @row_mode, @match_mode,
              @field_map, @merge_fields, @constants, @create_options, @create_links, @send_empty, @once_per_order, @is_default)`).run(args);
    destId = Number(res.lastInsertRowid);
  }

  if (isDefault) {
    // Etsy and Shopify each keep their own default, so one click can go to
    // either sheet without reconfiguring anything.
    db.prepare(`UPDATE airtable_destinations SET is_default = 0
                WHERE id <> ? AND channel = ? AND (shop_id IS ? OR shop_id IS NULL)`)
      .run(destId, channel, shopId);
  }
  return getDestination(destId);
}

export function deleteDestination(id) {
  const db = getDb();
  db.prepare('DELETE FROM airtable_links WHERE destination_id = ?').run(id);
  db.prepare('DELETE FROM airtable_destinations WHERE id = ?').run(id);
  return { deleted: true, id };
}

// -------------------------------------------------------- value conversion

const NUMERIC = new Set(['number', 'currency', 'percent', 'duration', 'rating']);
const TEXTUAL = new Set(['singleLineText', 'multilineText', 'richText', 'email', 'url', 'phoneNumber', 'barcode', 'singleSelect']);

/** Bend one resolved value into what the target Airtable field will accept. */
export function coerce(value, field, { createLinks = false } = {}) {
  if (value === null || value === undefined || value === '') return { skip: true };
  const type = field?.type ?? 'singleLineText';

  if (NUMERIC.has(type)) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? { value } : { skip: true, reason: `"${value}" is not a number` };
    }
    // Strip currency symbols and thousands separators, but refuse anything that
    // is not a number underneath - writing a silent 0 would be worse than
    // leaving the cell alone.
    const cleaned = String(value).replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
    const n = Number(cleaned);
    return cleaned !== '' && Number.isFinite(n)
      ? { value: n }
      : { skip: true, reason: `"${value}" is not a number` };
  }
  if (type === 'checkbox') return { value: !!value };
  if (type === 'date') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? { skip: true, reason: `"${value}" is not a date` } : { value: d.toISOString().slice(0, 10) };
  }
  if (type === 'dateTime') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? { skip: true, reason: `"${value}" is not a date` } : { value: d.toISOString() };
  }
  if (type === 'multipleSelects') {
    const list = Array.isArray(value) ? value : String(value).split(/\s*[,|]\s*/).filter(Boolean);
    return list.length ? { value: list.map(String) } : { skip: true };
  }
  if (type === 'multipleRecordLinks') {
    if (!createLinks) {
      return { skip: true, reason: `"${field.name}" links to another table; turn on "Create linked rows" to fill it` };
    }
    const list = Array.isArray(value) ? value : String(value).split(/\s*[,|]\s*/).filter(Boolean);
    return list.length ? { value: list.map(String) } : { skip: true };
  }
  if (type === 'multipleAttachments') {
    const urls = (Array.isArray(value) ? value : String(value).split(/\s+/)).filter((u) => /^https?:\/\//.test(u));
    return urls.length ? { value: urls.map((url) => ({ url })) } : { skip: true, reason: 'not a public image URL' };
  }
  if (type === 'url' && !/^https?:\/\//i.test(String(value))) return { skip: true, reason: 'not a URL' };
  if (TEXTUAL.has(type)) return { value: String(value) };

  return { value: typeof value === 'object' ? JSON.stringify(value) : value };
}

/**
 * Fetch whatever the mapping needs but does not have yet, so the user never
 * has to remember to press a "refresh" button first: exchange rates when a
 * column is fed by a rate or a converted total, and Etsy's per-variation
 * photos when a column wants the variant image.
 */
async function prepareSources(destination, receiptIds) {
  const used = new Set((destination.fieldMap ?? []).map((e) => e.source));
  const needsRates = [...used].some((k) => k.startsWith('rate.') || k.endsWith('_usd'));
  // Every column that resolves to a picture needs the variation map on hand,
  // or the cell arrives empty for the listings that have not been synced.
  const needsVariantImages = [...used].some((k) => k.startsWith('item.variant_image')
    || k === 'item.image_any' || k === 'item.first_image' || k === 'item.last_image'
    || k === 'item.first_last_image' || k === 'item.all_images' || k === 'item.image_count');
  // The buyer's email is worth chasing before a push: it is the column most
  // often blank, and the single-receipt endpoint usually has it.
  const needsEmail = [...used].some((k) => k.startsWith('buyer.email'));

  if (needsRates) {
    try { await ensureRates(); } catch (err) { log.warn(`rates unavailable: ${err.message}`); }
  }
  if (needsVariantImages) {
    try { await syncForReceipts(receiptIds); } catch (err) { log.warn(`variant images unavailable: ${err.message}`); }
  }
  if (needsEmail) {
    const missing = getDb().prepare(`
      SELECT receipt_id FROM receipts
      WHERE receipt_id IN (${receiptIds.map(() => '?').join(',')})
        AND COALESCE(buyer_email,'') = '' AND COALESCE(payment_email,'') = ''`).all(...receiptIds);
    if (missing.length) {
      try { await enrichReceiptContacts({ receiptIds: missing.map((r) => r.receipt_id) }); }
      catch (err) { log.warn(`could not chase buyer emails: ${err.message}`); }
    }
  }
}

/**
 * Turn the selected orders into Airtable records, without calling Airtable.
 * This is what the preview shows and what the push then sends, so what the
 * user approves is exactly what goes.
 */
export async function buildRecords(destination, receiptIds, { table: known = null } = {}) {
  const table = known ?? await at.getTable(destination.baseId, destination.tableId);
  const byName = new Map(table.fields.map((f) => [f.name, f]));
  const rows = loadRows(receiptIds, { rowMode: destination.rowMode });

  if (!rows.length) throw badRequest('None of those orders are in this shop. Sync orders first, or switch shop.');

  const issues = [];
  // Which row is the first of its order, so order-level values are written
  // once instead of on every line.
  const seenReceipts = new Set();
  const records = rows.map((row) => {
    const fields = {};
    const skipped = [];
    const isFirstRowOfOrder = !seenReceipts.has(row.receiptId);
    seenReceipts.add(row.receiptId);

    for (const entry of destination.fieldMap) {
      const field = byName.get(entry.target);
      if (!field) { skipped.push(`${entry.target}: no longer exists in Airtable`); continue; }
      if (!field.writable) { skipped.push(`${entry.target}: Airtable computes this column`); continue; }

      // The order total, the address, the parcel: writing them again on the
      // second item of the same order would count them twice.
      if (destination.oncePerOrder && !isFirstRowOfOrder
          && isOrderLevel(entry.source) && !destination.mergeFields.includes(entry.target)) {
        continue;
      }

      const raw = resolveSource(entry.source, row);
      const out = coerce(raw, field, { createLinks: destination.createLinks });
      if (out.skip) {
        if (out.reason) skipped.push(`${entry.target}: ${out.reason}`);
        else if (destination.sendEmpty) fields[entry.target] = null;
        continue;
      }
      fields[entry.target] = out.value;
    }

    for (const [name, value] of Object.entries(destination.constants ?? {})) {
      const field = byName.get(name);
      if (!field?.writable) continue;
      const out = coerce(value, field, { createLinks: destination.createLinks });
      if (!out.skip) fields[name] = out.value;
    }

    if (skipped.length) issues.push({ receiptId: row.receiptId, skipped });
    return { receiptId: row.receiptId, transactionId: row.transactionId, fields };
  });

  return { records, issues, table };
}

// ------------------------------------------------------------------- links

function rememberLink(destinationId, receiptId, transactionId, recordId) {
  getDb().prepare(`
    INSERT INTO airtable_links (destination_id, shop_id, receipt_id, transaction_id, record_id, last_pushed_at)
    VALUES (?,?,?,?,?, datetime('now'))
    ON CONFLICT(destination_id, receipt_id, transaction_id)
    DO UPDATE SET record_id = excluded.record_id, last_pushed_at = excluded.last_pushed_at`)
    .run(destinationId, activeShopId(), receiptId, transactionId ?? 0, recordId);
}

export function linksFor(destinationId, receiptIds = []) {
  if (!receiptIds.length) return [];
  const holes = receiptIds.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT receipt_id, transaction_id, record_id, last_pushed_at
    FROM airtable_links WHERE destination_id = ? AND receipt_id IN (${holes})`)
    .all(destinationId, ...receiptIds);
}

/** Which of these orders have already been sent, for the badge in the list. */
export function syncedReceiptIds(receiptIds = []) {
  if (!receiptIds.length) return {};
  const holes = receiptIds.map(() => '?').join(',');
  const rows = getDb().prepare(`
    SELECT l.receipt_id, MAX(l.last_pushed_at) AS last_pushed_at, COUNT(*) AS rows_pushed
    FROM airtable_links l
    JOIN airtable_destinations d ON d.id = l.destination_id
    WHERE l.shop_id IS ? AND l.receipt_id IN (${holes})
    GROUP BY l.receipt_id`).all(activeShopId(), ...receiptIds);
  return Object.fromEntries(rows.map((r) => [r.receipt_id, { lastPushedAt: r.last_pushed_at, rows: r.rows_pushed }]));
}

// -------------------------------------------------------------------- push

function recordRun(destinationId, mode, summary) {
  getDb().prepare(`
    INSERT INTO airtable_runs (destination_id, shop_id, mode, created, updated, deleted, skipped, failed, detail)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(destinationId, activeShopId(), mode, summary.created ?? 0, summary.updated ?? 0,
      summary.deleted ?? 0, summary.skipped ?? 0, summary.failed ?? 0, JSON.stringify(summary.detail ?? {}));
}

export function listRuns(limit = 20) {
  return getDb().prepare(`
    SELECT r.*, d.label FROM airtable_runs r
    LEFT JOIN airtable_destinations d ON d.id = r.destination_id
    WHERE r.shop_id IS ? ORDER BY r.id DESC LIMIT ?`).all(activeShopId(), limit)
    .map((r) => ({ ...r, detail: parse(r.detail, {}) }));
}

/**
 * Send orders to Airtable.
 *
 *   mode 'upsert' (default) - add new rows, update rows that already exist
 *   mode 'update'           - only touch rows this app has pushed before
 *   mode 'delete'           - remove the rows this app pushed for these orders
 *
 * `dryRun` returns the exact payload without contacting Airtable.
 */
export async function push({ destinationId, receiptIds = [], mode = 'upsert', dryRun = false, channel = 'etsy' }) {
  if (!receiptIds.length) throw badRequest('Select at least one order.');
  const destination = destinationId ? getDestination(destinationId) : defaultDestination(channel);
  if (!destination) throw badRequest('No Airtable destination is set up yet. Add one in Settings > Airtable.');

  if (mode === 'delete') return remove(destination, receiptIds, dryRun);

  if (!destination.fieldMap.length && !Object.keys(destination.constants ?? {}).length) {
    throw badRequest(`"${destination.label}" has no field mapping yet. Open it in Settings > Airtable and match the fields.`);
  }

  await prepareSources(destination, receiptIds);
  const { records, issues, table } = await buildRecords(destination, receiptIds);
  const known = linksFor(destination.id, receiptIds);
  const knownByRow = new Map(known.map((l) => [`${l.receipt_id}:${l.transaction_id}`, l.record_id]));

  if (dryRun) {
    return {
      dryRun: true,
      destination: { id: destination.id, label: destination.label, table: table.name, rowMode: destination.rowMode },
      mode,
      mergeFields: destination.mergeFields,
      rows: records.map((r) => ({
        receiptId: r.receiptId,
        transactionId: r.transactionId,
        existingRecordId: knownByRow.get(`${r.receiptId}:${r.transactionId ?? 0}`) ?? null,
        fields: r.fields,
      })),
      issues,
      willCreate: records.filter((r) => !knownByRow.has(`${r.receiptId}:${r.transactionId ?? 0}`)).length,
      willUpdate: records.filter((r) => knownByRow.has(`${r.receiptId}:${r.transactionId ?? 0}`)).length,
    };
  }

  const summary = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [], issues };
  const typecast = destination.createOptions;

  // Rows we have pushed before go by record id - that survives someone editing
  // the key column inside Airtable.
  const withId = [];
  const fresh = [];
  for (const record of records) {
    const existing = knownByRow.get(`${record.receiptId}:${record.transactionId ?? 0}`);
    if (existing) withId.push({ ...record, id: existing });
    else if (mode === 'update') summary.skipped += 1;
    else fresh.push(record);
  }

  try {
    if (withId.length) {
      const updated = await at.updateRecords(
        destination.baseId, destination.tableId,
        withId.map((r) => ({ id: r.id, fields: r.fields })),
        { typecast },
      );
      summary.updated += updated.length;
      withId.forEach((r) => rememberLink(destination.id, r.receiptId, r.transactionId, r.id));
    }

    if (fresh.length) {
      if (destination.mergeFields.length) {
        const res = await at.upsertRecords(
          destination.baseId, destination.tableId,
          fresh.map((r) => r.fields), destination.mergeFields, { typecast },
        );
        summary.created += res.createdRecordIds.length;
        summary.updated += res.updatedRecordIds.length;

        // Tie each returned record back to its order by the key columns rather
        // than by position: linking the wrong record id would make the next
        // push overwrite someone else's row.
        const keyOf = (fields) => destination.mergeFields
          .map((name) => JSON.stringify(fields?.[name] ?? null)).join('|');
        const byKey = new Map(fresh.map((r) => [keyOf(r.fields), r]));
        res.records.forEach((rec) => {
          const row = byKey.get(keyOf(rec?.fields));
          if (row && rec?.id) rememberLink(destination.id, row.receiptId, row.transactionId, rec.id);
        });
      } else {
        const created = await at.createRecords(
          destination.baseId, destination.tableId, fresh.map((r) => r.fields), { typecast },
        );
        summary.created += created.length;
        created.forEach((rec, i) => {
          const row = fresh[i];
          if (row && rec?.id) rememberLink(destination.id, row.receiptId, row.transactionId, rec.id);
        });
      }
    }
  } catch (err) {
    summary.failed = records.length - summary.created - summary.updated;
    summary.errors.push(err.message);
    recordRun(destination.id, mode, { ...summary, detail: { error: err.message } });
    throw err;
  }

  getDb().prepare("UPDATE airtable_destinations SET last_push_at = datetime('now') WHERE id = ?").run(destination.id);
  recordRun(destination.id, mode, summary);
  log.info(`pushed ${summary.created} new and ${summary.updated} updated rows to ${destination.label}`);

  return { ...summary, destination: { id: destination.id, label: destination.label, table: table.name }, mode };
}

/** Remove the Airtable rows this app created for these orders. */
async function remove(destination, receiptIds, dryRun) {
  const links = linksFor(destination.id, receiptIds);
  if (!links.length) return { deleted: 0, skipped: receiptIds.length, mode: 'delete', note: 'Nothing was pushed to this destination yet.' };
  if (dryRun) {
    return { dryRun: true, mode: 'delete', destination: { id: destination.id, label: destination.label },
      willDelete: links.length, rows: links.map((l) => ({ receiptId: l.receipt_id, recordId: l.record_id })) };
  }

  const deleted = await at.deleteRecords(destination.baseId, destination.tableId, links.map((l) => l.record_id));
  const db = getDb();
  for (const l of links) {
    db.prepare('DELETE FROM airtable_links WHERE destination_id = ? AND receipt_id = ? AND transaction_id = ?')
      .run(destination.id, l.receipt_id, l.transaction_id);
  }
  recordRun(destination.id, 'delete', { deleted: deleted.length });
  return { deleted: deleted.length, mode: 'delete', destination: { id: destination.id, label: destination.label } };
}

// ---------------------------------------------------------------- matching

/** Propose a mapping for a table, either by name or with the AI. */
export async function proposeMapping({ baseId, tableId, mode = 'name', provider, rowMode = 'item' }) {
  const table = await at.getTable(baseId, tableId);
  const shop = currentShop();

  const result = mode === 'ai'
    ? await matchByAi({ table: table.name, fields: table.fields, provider,
      shopName: shop?.airtableName || shop?.shopName, rowMode })
    : matchByName(table.fields);

  const mergeFields = result.mergeFields?.length ? result.mergeFields : suggestMergeFields(result.map, table.fields);

  return {
    ...result,
    mergeFields,
    table: { id: table.id, name: table.name, fields: table.fields },
    sourceFields: SOURCE_FIELDS.map(({ key, label, group, hint }) => ({ key, label, group, hint })),
  };
}
