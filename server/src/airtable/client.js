/**
 * Airtable Web API v0 client.
 *
 * Everything goes through the shared outbound wrapper, so Airtable sees the
 * same fixed User-Agent as every other destination and no machine or locale
 * details, and an optional proxy applies here too.
 *
 * The two limits that shape this file, both from Airtable's own docs:
 *   - 5 requests per second per base (429 then demands a 30 second pause)
 *   - batch writes take at most 10 records per request
 */
import { outboundFetch } from '../lib/outbound.js';
import { readSetting } from '../services/settings.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('airtable');

const API = 'https://api.airtable.com/v0';
export const BATCH_SIZE = 10;
/** Airtable allows 5/sec per base; stay just under it. */
const MIN_GAP_MS = 220;
const RATE_LIMIT_PAUSE_MS = 30_000;

/** Field types the API refuses to write to - never offer these as a target. */
export const READ_ONLY_FIELD_TYPES = new Set([
  'formula', 'rollup', 'count', 'lookup', 'multipleLookupValues',
  'autoNumber', 'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
  'button', 'aiText', 'externalSyncSource',
]);

export const isWritable = (field) => !READ_ONLY_FIELD_TYPES.has(field?.type);

export function getToken() {
  return (readSetting('airtable.token') || '').trim();
}

export const hasToken = () => !!getToken();

function requireToken() {
  const token = getToken();
  if (!token) {
    throw badRequest('No Airtable token yet. Add a personal access token in Settings > Airtable.');
  }
  return token;
}

/** One queue per base keeps us inside the per-base rate limit. */
const lastCallAt = new Map();

async function pace(baseId) {
  const key = baseId || 'meta';
  const gap = Date.now() - (lastCallAt.get(key) ?? 0);
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastCallAt.set(key, Date.now());
}

/**
 * A single API call, with the retries Airtable's own limits require:
 * 429 means wait the documented 30 seconds; 5xx is worth a short back-off.
 */
async function call(path, { method = 'GET', query, body, baseId, attempt = 0 } = {}) {
  const token = requireToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, String(v));
  }

  await pace(baseId);

  let res;
  try {
    res = await outboundFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new AppError(502, `Could not reach Airtable: ${err.message}`);
  }

  if (res.status === 429 && attempt < 2) {
    log.warn(`rate limited by Airtable, waiting ${RATE_LIMIT_PAUSE_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS));
    return call(path, { method, query, body, baseId, attempt: attempt + 1 });
  }
  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    return call(path, { method, query, body, baseId, attempt: attempt + 1 });
  }

  const text = await res.text();
  const payload = text ? safeJson(text) : {};

  if (!res.ok) {
    const detail = payload?.error?.message || payload?.error?.type || text.slice(0, 300);
    throw new AppError(
      res.status === 404 ? 404 : 400,
      airtableErrorHint(res.status, payload?.error?.type, detail),
      { airtableStatus: res.status, airtableType: payload?.error?.type },
    );
  }
  return payload;
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return { raw: text }; } };

/** Airtable's error types are terse; say what the user can actually do about it. */
function airtableErrorHint(status, type, detail) {
  if (status === 401) return 'Airtable rejected the token. Check it in Settings > Airtable (it starts with "pat").';
  if (status === 403) {
    return 'The token is valid but not allowed to do this. Give it the scopes data.records:write and schema.bases:read, '
      + 'and make sure this base is in its access list.';
  }
  if (type === 'INVALID_MULTIPLE_CHOICE_OPTIONS') {
    return `${detail} - the value does not exist as an option in that select field. Turn on "Create missing options" for this destination.`;
  }
  if (type === 'INVALID_VALUE_FOR_COLUMN') return `${detail} - the value does not fit that Airtable field's type.`;
  if (type === 'ROW_DOES_NOT_EXIST') return 'That Airtable record no longer exists (someone deleted it in Airtable).';
  if (type === 'TABLE_NOT_FOUND') return 'That table no longer exists in the base. Pick the destination again in Settings.';
  return detail || `Airtable returned ${status}.`;
}

// ------------------------------------------------------------------ schema

/** Every base the token can see. */
export async function listBases() {
  const out = [];
  let offset;
  do {
    const page = await call('/meta/bases', { query: { offset } });
    out.push(...(page.bases ?? []).map((b) => ({ id: b.id, name: b.name, permission: b.permissionLevel })));
    offset = page.offset;
  } while (offset && out.length < 200);
  return out;
}

/**
 * Tables in a base, with their fields and views. Writable fields are flagged
 * so the mapping UI can grey out the computed ones instead of letting a user
 * map onto a formula and only find out when the push fails.
 */
export async function listTables(baseId) {
  const page = await call(`/meta/bases/${baseId}/tables`, { baseId });
  return (page.tables ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    primaryFieldId: t.primaryFieldId,
    fields: (t.fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      writable: isWritable(f),
      choices: f.options?.choices?.map((c) => c.name) ?? undefined,
      linkedTableId: f.options?.linkedTableId ?? undefined,
    })),
    views: (t.views ?? []).map((v) => ({ id: v.id, name: v.name, type: v.type })),
  }));
}

export async function getTable(baseId, tableId) {
  const tables = await listTables(baseId);
  const table = tables.find((t) => t.id === tableId || t.name === tableId);
  if (!table) throw notFound(`Table ${tableId} is not in base ${baseId}.`);
  return table;
}

// ----------------------------------------------------------------- records

/** Read records, following pagination. `max` keeps a preview cheap. */
export async function listRecords(baseId, tableId, { view, fields, filterByFormula, max = 100 } = {}) {
  const out = [];
  let offset;
  do {
    const page = await call(`/${baseId}/${encodeURIComponent(tableId)}`, {
      baseId,
      query: {
        view,
        filterByFormula,
        pageSize: Math.min(100, max - out.length),
        offset,
        ...(fields?.length ? { 'fields[]': fields } : {}),
      },
    });
    out.push(...(page.records ?? []));
    offset = page.offset;
  } while (offset && out.length < max);
  return out;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Create records, 10 at a time. `records` is an array of field objects. */
export async function createRecords(baseId, tableId, records, { typecast = true } = {}) {
  const created = [];
  for (const batch of chunk(records, BATCH_SIZE)) {
    const res = await call(`/${baseId}/${encodeURIComponent(tableId)}`, {
      baseId,
      method: 'POST',
      body: { records: batch.map((fields) => ({ fields })), typecast },
    });
    created.push(...(res.records ?? []));
  }
  return created;
}

/** Update records by id, 10 at a time. `records` is [{ id, fields }]. */
export async function updateRecords(baseId, tableId, records, { typecast = true } = {}) {
  const updated = [];
  for (const batch of chunk(records, BATCH_SIZE)) {
    const res = await call(`/${baseId}/${encodeURIComponent(tableId)}`, {
      baseId,
      method: 'PATCH',
      body: { records: batch, typecast },
    });
    updated.push(...(res.records ?? []));
  }
  return updated;
}

/**
 * Add-or-update in one call. Airtable matches on `mergeFields` (at most three,
 * and never a computed field), so re-sending the same order updates its row
 * instead of making a second one.
 */
export async function upsertRecords(baseId, tableId, records, mergeFields, { typecast = true } = {}) {
  if (!mergeFields?.length) throw badRequest('Upsert needs at least one field to match on.');
  if (mergeFields.length > 3) throw badRequest('Airtable matches on at most three fields.');

  const result = { records: [], createdRecordIds: [], updatedRecordIds: [] };
  for (const batch of chunk(records, BATCH_SIZE)) {
    const res = await call(`/${baseId}/${encodeURIComponent(tableId)}`, {
      baseId,
      method: 'PATCH',
      body: {
        performUpsert: { fieldsToMergeOn: mergeFields },
        records: batch.map((fields) => ({ fields })),
        typecast,
      },
    });
    result.records.push(...(res.records ?? []));
    result.createdRecordIds.push(...(res.createdRecords ?? []));
    result.updatedRecordIds.push(...(res.updatedRecords ?? []));
  }
  return result;
}

/** Delete records by id, 10 at a time. */
export async function deleteRecords(baseId, tableId, recordIds) {
  const deleted = [];
  for (const batch of chunk(recordIds, BATCH_SIZE)) {
    const res = await call(`/${baseId}/${encodeURIComponent(tableId)}`, {
      baseId,
      method: 'DELETE',
      query: { 'records[]': batch },
    });
    deleted.push(...(res.records ?? []));
  }
  return deleted;
}

/** Cheap "is this token alive" probe for the Settings screen. */
export async function testToken() {
  const bases = await listBases();
  return { ok: true, baseCount: bases.length, bases: bases.slice(0, 25) };
}
