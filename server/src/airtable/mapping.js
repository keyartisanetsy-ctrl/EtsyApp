/**
 * Two ways to decide which app field feeds which Airtable column.
 *
 *   matchByName  - deterministic, offline, explainable. Normalises both sides
 *                  (accents, Turkish letters, punctuation) and leans on a
 *                  synonym table so "Takip No" finds the tracking number and
 *                  "Ship Zipcode" finds the post code.
 *   matchByAi    - hands the Airtable schema and this app's field catalogue to
 *                  the configured AI provider and asks for the mapping.
 *
 * Both return the same shape, so the UI, the preview and the push engine treat
 * an AI mapping exactly like a hand-made one - it stays visible and editable
 * instead of being a black box.
 */
import { SOURCE_FIELDS, sampleValues } from './fields.js';
import { run, parseJsonish } from '../services/ai/index.js';
import { badRequest } from '../lib/errors.js';

/** Lowercase, strip accents and Turkish letters, collapse punctuation. */
export function normalise(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Airtable column name (normalised) -> source key. Covers the English and
 * Turkish column names these sheets actually use.
 */
const SYNONYMS = {
  'order id': 'order.id',
  'order no': 'order.id',
  'order number': 'order.id',
  'siparis id': 'order.id',
  'siparis no': 'order.id',
  'siparis numarasi': 'order.id',
  'etsy order number': 'order.id',
  'receipt id': 'order.id',

  'sale date': 'order.date',
  'order date': 'order.date',
  'siparis tarihi': 'order.date',
  tarih: 'order.date',
  date: 'order.date',

  'full name': 'buyer.name',
  name: 'buyer.name',
  isim: 'buyer.name',
  'ad soyad': 'buyer.name',
  alici: 'buyer.name',
  'buyer name': 'buyer.name',
  'customer name': 'buyer.name',

  email: 'buyer.email',
  'e mail': 'buyer.email',
  mail: 'buyer.email',
  eposta: 'buyer.email',
  'e posta': 'buyer.email',

  street: 'address.street',
  address: 'address.street',
  adres: 'address.street',
  'address 1': 'address.line1',
  'address line 1': 'address.line1',
  'address 2': 'address.line2',
  'address line 2': 'address.line2',

  city: 'address.city',
  'ship city': 'address.city',
  sehir: 'address.city',
  ilce: 'address.city',

  state: 'address.state',
  'ship state': 'address.state',
  province: 'address.state',
  'province state': 'address.state',
  eyalet: 'address.state',
  il: 'address.state',

  zip: 'address.zip',
  zipcode: 'address.zip',
  'zip code': 'address.zip',
  'ship zipcode': 'address.zip',
  postcode: 'address.zip',
  'postal code': 'address.zip',
  'posta kodu': 'address.zip',

  country: 'address.country',
  countrycode: 'address.country',
  'country code': 'address.country',
  'ship country': 'address.country',
  ulke: 'address.country',

  phone: 'buyer.phone',
  'phone number': 'buyer.phone',
  telefon: 'buyer.phone',

  quantity: 'item.quantity',
  qty: 'item.quantity',
  adet: 'item.quantity',
  miktar: 'item.quantity',

  'order total': 'total.grand',
  total: 'total.grand',
  toplam: 'total.grand',
  tutar: 'total.grand',
  revenue: 'total.grand',
  'shipping cost': 'total.shipping',
  kargo: 'total.shipping',
  tax: 'total.tax',
  vergi: 'total.tax',
  currency: 'total.currency',
  'para birimi': 'total.currency',

  sku: 'item.sku',
  'stok kodu': 'item.sku',

  title: 'item.title',
  baslik: 'item.title',
  'product title': 'item.title',
  urun: 'item.title',
  'urun adi': 'item.title',
  'baslik ilk 40': 'item.title40',
  'title 40': 'item.title40',

  variants: 'item.variations',
  variant: 'item.variations',
  variation: 'item.variations',
  'variant name': 'item.variations',
  varyant: 'item.variations',
  varyasyon: 'item.variations',
  'varyant adi': 'item.variations',

  'image link': 'item.image_url',
  'image url': 'item.image_url',
  image: 'item.image_url',
  gorsel: 'item.image_url',
  'urun gorsel': 'item.image_url',

  'etsy link': 'item.etsy_link',
  'product url': 'item.etsy_link',
  'marketplace url': 'item.etsy_link',
  'listing link': 'item.etsy_link',
  'order link': 'order.etsy_url',

  'urun tedarik link': 'item.supply_link',
  'tedarik link': 'item.supply_link',
  'supplier link': 'item.supply_link',
  'buying url': 'item.supply_link',
  'source url': 'item.supply_link',
  'dropshipping link': 'item.supply_link',
  'link dropshipping': 'item.supply_link',

  'takip no': 'tracking.code',
  takip: 'tracking.code',
  tracking: 'tracking.code',
  'tracking no': 'tracking.code',
  'tracking number': 'tracking.code',
  'tracking code': 'tracking.code',
  'kargo takip': 'tracking.code',
  'kargo takip no': 'tracking.code',
  'tracking link': 'tracking.url',
  'tracking url': 'tracking.url',
  carrier: 'tracking.carrier',
  'shipping company': 'tracking.carrier',

  magaza: 'shop.name',
  shop: 'shop.name',
  store: 'shop.name',
  'shop name': 'shop.name',
  'etsy magaza': 'shop.name',
  channel: 'shop.name',

  note: 'order.buyer_message',
  not: 'order.buyer_message',
  notes: 'order.buyer_message',
  'buyer note': 'order.buyer_message',
  'note section': 'order.buyer_message',
  message: 'order.buyer_message',
  'gift message': 'order.gift_message',
  status: 'order.status',
  durum: 'order.status',
  'siparis durum': 'order.status',
};

const tokens = (text) => normalise(text).split(' ').filter(Boolean);

/** Rough token overlap, used only to break ties when no synonym applies. */
function overlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / Math.max(A.size, B.size);
}

/**
 * Deterministic mapping. Returns one entry per writable Airtable field it is
 * reasonably sure about, each carrying why it matched so the UI can show it.
 */
export function matchByName(fields = []) {
  const map = [];
  const unmatched = [];
  // A guessed match may claim a source once. Exact synonym hits may repeat,
  // since two columns legitimately wanting the order number is normal, but
  // "NOT 1" and "NOT 2" should not both quietly grab the buyer's message.
  const claimed = new Set();

  for (const field of fields) {
    if (!field.writable) continue;
    const key = normalise(field.name);

    // 1. straight synonym hit
    let source = SYNONYMS[key] ?? null;
    let confidence = source ? 'high' : null;
    let why = source ? `"${field.name}" is a known name for this field` : null;

    // 2. synonym hit after dropping a trailing "copy"/number Airtable adds
    if (!source) {
      const trimmed = key.replace(/\b(copy|copy copy|[0-9]+)\b/g, '').trim();
      if (trimmed && SYNONYMS[trimmed]) {
        source = SYNONYMS[trimmed];
        confidence = 'medium';
        why = `matched "${field.name}" to "${trimmed}"`;
      }
    }

    // 3. best token overlap against the catalogue's labels
    if (!source) {
      let best = { score: 0, key: null, label: null };
      for (const candidate of SOURCE_FIELDS) {
        const score = Math.max(overlap(field.name, candidate.label), overlap(field.name, candidate.key.split('.').pop()));
        if (score > best.score) best = { score, key: candidate.key, label: candidate.label };
      }
      if (best.score >= 0.6) {
        source = best.key;
        confidence = best.score >= 0.9 ? 'medium' : 'low';
        why = `"${field.name}" looks like "${best.label}"`;
      }
    }

    const known = source && SOURCE_FIELDS.some((f) => f.key === source);
    const alreadyTaken = confidence !== 'high' && claimed.has(source);
    if (known && !alreadyTaken) {
      claimed.add(source);
      map.push({ target: field.name, source, confidence, why });
    } else {
      unmatched.push(field.name);
    }
  }

  return { map, unmatched, mode: 'name' };
}

const AI_SYSTEM = `You map an e-commerce app's order fields onto the columns of an Airtable table.

You are given the Airtable columns (name, type, and for select columns their existing options) and the
app's available source fields (key, what it means, and a real sample value from a recent order).

Rules:
- Only map columns that appear in the AIRTABLE COLUMNS list. Never invent a column.
- Only use source keys that appear in the SOURCE FIELDS list. Never invent a key.
- Leave a column out entirely rather than guessing badly. A missing mapping is much better than a wrong one.
- Types must make sense: a date column needs a date source, a number/currency column needs a numeric source,
  a checkbox needs a true/false source, a url column needs a link.
- mergeFields: pick 1-3 column names that together uniquely identify one row, so re-sending the same order
  updates its row instead of adding a duplicate. The order number is usually the right choice. Only pick
  columns of type number, text, long text, single select, multiple select or date.
- constants: if a column identifies which shop or channel the row came from and its value is the same for
  every row of this destination (for example a shop name column), put it here with the exact value to use.
- Column names must be copied exactly, including spaces, capitals and Turkish characters.

Reply with JSON only, no prose:
{"map":[{"target":"<airtable column>","source":"<source key>","why":"<short reason>"}],
 "mergeFields":["<airtable column>"],
 "constants":{"<airtable column>":"<value>"}}`;

/**
 * Ask the configured AI provider for the mapping. The result is validated
 * against both schemas before it is returned, so a hallucinated column or
 * source key is dropped rather than saved.
 */
export async function matchByAi({ table, fields = [], provider, shopName, rowMode = 'item', runner = run }) {
  const writable = fields.filter((f) => f.writable);
  if (!writable.length) throw badRequest('That table has no writable columns.');

  const samples = sampleValues(rowMode);
  const context = {
    airtableTable: table,
    airtableColumns: writable.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.choices?.length ? { existingOptions: f.choices.slice(0, 12) } : {}),
    })),
    sourceFields: SOURCE_FIELDS.map((f) => ({
      key: f.key,
      means: f.hint,
      sample: samples[f.key] ?? null,
    })),
    thisShopIsCalled: shopName ?? null,
    oneRowPer: rowMode === 'item' ? 'order line item' : 'order',
  };

  const result = await runner({
    kind: 'custom',
    provider,
    promptOverride: AI_SYSTEM,
    context,
    userInput: 'Map the columns now. JSON only.',
    maxTokens: 2048,
  });

  const parsed = parseJsonish(result.text);
  if (!parsed) throw badRequest('The AI did not return a usable mapping. Try again, or map the fields by name.');

  const validNames = new Set(writable.map((f) => f.name));
  const validSources = new Set(SOURCE_FIELDS.map((f) => f.key));
  const mergeable = new Set(writable
    .filter((f) => ['singleLineText', 'multilineText', 'number', 'currency', 'percent', 'singleSelect', 'multipleSelects', 'date', 'dateTime', 'autoNumber', 'email', 'url', 'phoneNumber']
      .includes(f.type))
    .map((f) => f.name));

  const dropped = [];
  const map = [];
  for (const entry of parsed.map ?? []) {
    if (!validNames.has(entry?.target)) { dropped.push(`unknown column "${entry?.target}"`); continue; }
    if (!validSources.has(entry?.source)) { dropped.push(`unknown source "${entry?.source}" for "${entry?.target}"`); continue; }
    if (map.some((m) => m.target === entry.target)) continue;
    map.push({ target: entry.target, source: entry.source, confidence: 'ai', why: String(entry.why ?? '').slice(0, 140) });
  }

  const mergeFields = (parsed.mergeFields ?? [])
    .filter((n) => validNames.has(n) && mergeable.has(n))
    .slice(0, 3);

  const constants = {};
  for (const [name, value] of Object.entries(parsed.constants ?? {})) {
    if (validNames.has(name) && (typeof value === 'string' || typeof value === 'number')) constants[name] = value;
  }

  return {
    map,
    mergeFields,
    constants,
    dropped,
    unmatched: writable.map((f) => f.name).filter((n) => !map.some((m) => m.target === n) && !constants[n]),
    mode: 'ai',
    provider: result.provider,
    model: result.model,
    runId: result.runId,
  };
}

/**
 * Sensible merge fields when nobody picked any: whichever mapped column is fed
 * by the order id, since that is what makes a re-push an update.
 */
export function suggestMergeFields(map = [], fields = []) {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const orderish = map.filter((m) => m.source === 'order.id' || m.source === 'order.id_hash');
  return orderish
    .filter((m) => byName.get(m.target) && !['multipleRecordLinks', 'multipleAttachments', 'checkbox'].includes(byName.get(m.target).type))
    .map((m) => m.target)
    .slice(0, 1);
}
