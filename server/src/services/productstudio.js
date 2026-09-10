/**
 * The bridge from Product Studio - the Taobao/1688 app - into this one.
 *
 * The point of it is one click: you find a product over there, press "Etsy'e
 * ekle", and its draft is waiting here, with the supplier links and the yuan
 * price already attached to the SKU.
 *
 * Two things shape how this is written.
 *
 * First, this app cannot know Product Studio's exact JSON. So the reader is
 * deliberately forgiving: it accepts the field names that app is likely to use
 * in English, Chinese and Turkish, takes the first one that has a value, and
 * reports what it understood. A payload it cannot read comes back saying which
 * field was missing rather than failing silently - and `dryRun` lets the other
 * app check the mapping before it sends anything for real.
 *
 * Second, nothing here goes to Etsy. A product arriving from Product Studio
 * becomes a *local* draft on the draft desk. You look at it, fix the title,
 * pick the category, and press Send yourself. An app that published straight to
 * a live shop on a button press in another app would be a bad idea, and this is
 * the one place where being slower is obviously right.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, audit } from '../db/index.js';
import { activeShopId } from '../etsy/shop.js';
import { config } from '../config.js';
import { readSetting, writeSetting } from './settings.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import * as drafts from './drafts.js';
import * as draftmedia from './draftmedia.js';
import * as taobao from './taobao.js';

const log = createLogger('product-studio');

/**
 * The names each field might arrive under.
 *
 * Ordered by how likely they are, and the first one carrying a value wins.
 * Chinese keys are here because a Taobao tool very often keeps the source
 * field names, and Turkish because the app was built for a Turkish desk.
 */
const ALIASES = {
  title: ['title', 'name', 'productName', 'product_name', 'etsyTitle', 'englishTitle',
    'title_en', 'baslik', 'urunAdi', 'urun_adi', '标题', '商品标题', '产品名称'],
  description: ['description', 'desc', 'details', 'body', 'productDescription',
    'aciklama', 'detay', '描述', '详情', '商品描述'],
  price: ['price', 'salePrice', 'sellPrice', 'etsyPrice', 'listPrice', 'retailPrice',
    'fiyat', 'satisFiyati', '价格', '售价'],
  cost: ['cost', 'costPrice', 'supplyPrice', 'purchasePrice', 'buyPrice', 'unitCost',
    'maliyet', 'alisFiyati', 'tedarikFiyati', '成本', '进价', '采购价'],
  currency: ['currency', 'currencyCode', 'costCurrency', 'paraBirimi', '货币'],
  quantity: ['quantity', 'qty', 'stock', 'inventory', 'adet', 'stok', '库存', '数量'],
  sku: ['sku', 'skuCode', 'code', 'itemCode', 'productCode', 'kod', 'urunKodu', '编码', '货号'],
  url: ['url', 'link', 'productUrl', 'sourceUrl', 'itemUrl', 'taobaoUrl', 'taobaoLink',
    'supplyLink', 'tedarikLink', 'urunLinki', '链接', '商品链接', '宝贝链接'],
  variantUrl: ['variantUrl', 'variantLink', 'skuUrl', 'skuLink', 'varyantLink', 'varyantUrl'],
  images: ['images', 'imageUrls', 'photos', 'pictures', 'imgs', 'gallery', 'mainImages',
    'gorseller', 'resimler', '图片', '主图', '商品图片'],
  variants: ['variants', 'variations', 'skus', 'options', 'varyantlar', 'secenekler', '规格', 'sku列表'],
  tags: ['tags', 'keywords', 'etsyTags', 'etiketler', 'anahtarKelimeler', '标签', '关键词'],
  materials: ['materials', 'material', 'malzeme', 'malzemeler', '材质'],
  supplier: ['supplier', 'source', 'platform', 'site', 'tedarikci', '供应商', '平台'],
  itemId: ['itemId', 'item_id', 'productId', 'numIid', 'num_iid', 'offerId', 'goodsId', '商品ID', '宝贝ID'],
  weight: ['weight', 'itemWeight', 'agirlik', '重量'],
  moq: ['moq', 'minOrder', 'minimumOrder', 'minAdet', '起订量'],
  shippingCost: ['shippingCost', 'freight', 'shipping', 'kargo', 'kargoUcreti', '运费'],
  taxonomyId: ['taxonomyId', 'taxonomy_id', 'categoryId', 'etsyCategoryId', 'kategoriId'],
  notes: ['notes', 'note', 'remark', 'comment', 'not', 'notlar', '备注'],
};

/**
 * Product Studio's own shapes, read exactly rather than guessed at.
 *
 * That app hands over two objects: a `NormalisedProduct` (what it scraped from
 * Taobao or 1688) and a `GeneratedListing` (what the AI wrote for Etsy). Neither
 * uses the field names a generic reader would guess - the item number is
 * `numIid`, the link is `sourceUrl`, the cost is `priceOriginal`, and the
 * English title lives in `titleTranslated` while `title` is still Chinese.
 *
 * Three details from its own export code that matter, and would be wrong if
 * guessed:
 *
 *   - An image has a `role`. Only "gallery" and "description" belong on a
 *     listing; "variant" photos are the swatches and "unused" is discarded.
 *   - Which URL to take is not obvious. `url` is often a local /api/media file
 *     that nothing outside that app can fetch, and `remoteUrl` is a CDN link
 *     that expires in about two days. `srcUrl` is the permanent marketplace
 *     original. So: a public working url, else the permanent source, else the
 *     expiring one - the opposite order from its Shopify export, because
 *     nothing here re-hosts the file.
 *   - Etsy renders no HTML, so `descHtml` is not a description. The AI's
 *     plain-text description is the one to use.
 */
function isProductStudioPayload(payload) {
  const p = payload?.product ?? payload;
  return !!(p && typeof p === 'object'
    && (p.numIid !== undefined || p.platform !== undefined)
    && (p.sourceUrl !== undefined || p.images !== undefined));
}

/** The AI's value for one field of the generated listing. */
const generatedField = (listing, key) =>
  (listing?.fields ?? []).find((f) => f.key === key)?.value ?? '';

/** Etsy's own tag rules, as Product Studio applies them on export. */
const usableTag = (tag) => {
  const t = String(tag ?? '').trim();
  return !!t && t.length <= 20 && t.split(/\s+/).length <= 3;
};

/** A URL something outside Product Studio can actually fetch. */
const publicImageUrl = (im) => {
  const usable = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u)
    && !/\/api\/media\//.test(u) ? u : null);
  // The permanent marketplace original is preferred over the CDN copy, which
  // expires in about two days - this app stores the link, not the file.
  return usable(im?.url) ?? usable(im?.srcUrl) ?? usable(im?.remoteUrl) ?? usable(im?.originalUrl) ?? null;
};

/** Read Product Studio's pair of objects into this app's shape. */
function readProductStudio(payload) {
  const p = payload.product ?? payload;
  const listing = payload.listing ?? payload.generated ?? null;

  // The AI's Etsy title wins, then the translated one; `title` alone is the
  // original Chinese and would go on the listing untranslated.
  const title = generatedField(listing, 'title') || p.titleTranslated || p.title || '';

  const description = generatedField(listing, 'description') || '';

  const tags = String(generatedField(listing, 'tags') || '')
    .split(/[,\n]/).map((t) => t.trim()).filter(usableTag).slice(0, 13);

  // Only the photos that belong on a listing, in the order they are shown.
  const images = (p.images ?? [])
    .filter((im) => im?.role === 'gallery' || im?.role === 'description' || im?.role === undefined)
    .map(publicImageUrl)
    .filter(Boolean);

  // The listing's variants override the product's when the AI rewrote them.
  const rawVariants = (listing?.variants?.length ? listing.variants : p.variants) ?? [];
  const variants = rawVariants.map((v, i) => ({
    name: v.nameTranslated || v.name || `Variant ${i + 1}`,
    sku: v.sku ?? '',
    price: v.price ?? null,
    url: '',
    image: publicImageUrl({ url: v.imageUrl }) ?? v.imageUrl ?? null,
    stock: v.stock ?? null,
  })).filter((v) => v.name || v.sku);

  return {
    title,
    description,
    // Etsy sells in your currency; the Taobao price is the cost, not the price.
    price: null,
    cost: p.priceOriginal ?? null,
    currency: (p.currencyOriginal || 'CNY').toUpperCase(),
    quantity: variants.reduce((n, v) => n + (v.stock ?? 0), 0) || 10,
    sku: '',
    url: p.sourceUrl ?? '',
    variantUrl: '',
    images,
    variants,
    tags,
    materials: [],
    supplier: p.platform === '1688' ? '1688' : 'taobao',
    itemId: p.numIid ? String(p.numIid) : null,
    moq: null,
    shippingCost: null,
    taxonomyId: null,
    // Everything Product Studio worked out that Etsy also wants.
    weightKg: p.weightKg ?? null,
    hsCode: p.hsCode ?? '',
    originCountry: p.originCountry ?? '',
    videoUrl: p.videoUrl ?? '',
    notes: [
      p.shopType ? `Type: ${p.shopType}` : '',
      p.category ? `Category: ${p.category}` : '',
      listing?.model ? `Written by ${listing.model}` : '',
    ].filter(Boolean).join('\n'),
  };
}

/** The first alias that actually carries something. */
function pick(payload, field) {
  for (const key of ALIASES[field] ?? []) {
    // Match case-insensitively, since one app writes productUrl and another ProductURL.
    const found = Object.keys(payload).find((k) => k.toLowerCase() === key.toLowerCase());
    if (found === undefined) continue;
    const value = payload[found];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && !value.length) continue;
    return { value, from: found };
  }
  return { value: null, from: null };
}

const asArray = (v) => {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  // A comma or newline separated string is just as likely as an array.
  return String(v).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
};

const asNumber = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // Prices arrive as "¥18.50", "18,50" or 18.5 depending on the tool.
  const cleaned = String(v).replace(/[^\d.,-]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/**
 * Turn whatever Product Studio sent into the shape this app works in.
 *
 * Returns both the result and a note of which incoming key fed each field, so
 * the setup screen can show the mapping and you can see at a glance whether it
 * understood the payload or guessed wrong.
 */
export function readProduct(payload = {}) {
  if (!payload || typeof payload !== 'object') throw badRequest('Send the product as a JSON object.');

  // Product Studio's own shape is read exactly. Everything else falls through
  // to the forgiving reader below, so another tool can still post here.
  if (isProductStudioPayload(payload)) {
    const product = readProductStudio(payload);
    const missing = [];
    if (!product.title) missing.push('a title');
    if (!product.url && !product.itemId) missing.push('the source link');
    return {
      product,
      source: 'product-studio',
      mapping: { '(read as)': 'Product Studio NormalisedProduct + GeneratedListing' },
      ignored: [],
      missing,
      linkReadAs: product.url ? (() => {
        const l = taobao.parseSupplyUrl(product.url);
        return l.ok ? { supplier: l.supplierLabel, itemId: l.itemId, cleanUrl: l.cleanUrl } : null;
      })() : null,
    };
  }

  const mapping = {};
  const take = (field) => {
    const { value, from } = pick(payload, field);
    if (from) mapping[field] = from;
    return value;
  };

  const url = take('url');
  const variantUrl = take('variantUrl');
  const parsedLink = url ? taobao.parseSupplyUrl(url) : { ok: false };

  // Images may be strings, or objects with a url on them.
  const images = asArray(take('images'))
    .map((i) => (typeof i === 'string' ? i : i?.url ?? i?.src ?? i?.image ?? null))
    .filter((u) => typeof u === 'string' && /^https?:/i.test(u));

  // Variants likewise: a list of names, or of objects.
  const variants = asArray(take('variants')).map((v) => {
    if (typeof v === 'string') return { name: v, sku: '', price: null, url: '', image: null };
    return {
      name: String(v.name ?? v.title ?? v.label ?? v.variant ?? v.spec ?? v['规格'] ?? '').trim(),
      sku: String(v.sku ?? v.code ?? '').trim(),
      price: asNumber(v.price ?? v.cost ?? null),
      url: String(v.url ?? v.link ?? '').trim(),
      image: typeof v.image === 'string' ? v.image : v.image?.url ?? v.imageUrl ?? null,
    };
  }).filter((v) => v.name || v.sku);

  const product = {
    title: take('title') ? String(take('title')).trim() : '',
    description: take('description') ? String(take('description')).trim() : '',
    price: asNumber(take('price')),
    cost: asNumber(take('cost')),
    currency: (take('currency') ?? 'CNY').toString().toUpperCase(),
    quantity: asNumber(take('quantity')) ?? 10,
    sku: take('sku') ? String(take('sku')).trim() : '',
    url: url ? String(url).trim() : '',
    variantUrl: variantUrl ? String(variantUrl).trim() : '',
    images,
    variants,
    tags: asArray(take('tags')).map((t) => String(t).trim()).filter(Boolean).slice(0, 13),
    materials: asArray(take('materials')).map((m) => String(m).trim()).filter(Boolean),
    supplier: (take('supplier') ?? parsedLink.supplier ?? 'taobao').toString().toLowerCase(),
    itemId: take('itemId') ? String(take('itemId')) : parsedLink.itemId ?? null,
    moq: asNumber(take('moq')),
    shippingCost: asNumber(take('shippingCost')),
    taxonomyId: asNumber(take('taxonomyId')),
    notes: take('notes') ? String(take('notes')).trim() : '',
  };

  // What is missing, in the order it will bite.
  const missing = [];
  if (!product.title) missing.push('a title');
  if (!product.url && !product.itemId) missing.push('the supplier link');
  if (product.cost === null && product.price === null) missing.push('a price or a cost');

  return {
    product,
    mapping,
    missing,
    // Keys we did not recognise, so an unmapped field is visible rather than lost.
    ignored: Object.keys(payload).filter((k) =>
      !Object.values(mapping).some((used) => used.toLowerCase() === k.toLowerCase())),
    linkReadAs: parsedLink.ok ? {
      supplier: parsedLink.supplierLabel, itemId: parsedLink.itemId, cleanUrl: parsedLink.cleanUrl,
    } : null,
  };
}

/**
 * Take a product in and leave a draft on the desk.
 *
 * The supply record is written first, because it is keyed by SKU and the rest
 * of the app reads it from there. Then the draft, which is what you actually
 * open and finish.
 */
export function receive(payload = {}, { dryRun = false } = {}) {
  const read = readProduct(payload);
  const p = read.product;

  if (read.missing.length) {
    throw badRequest(`Product Studio sent something this app could not use: it needs ${read.missing.join(', ')}.`, {
      missing: read.missing,
      understood: read.mapping,
      ignored: read.ignored,
      hint: 'Send a title and the supplier link at minimum. The setup screen lists every field name accepted.',
    });
  }

  // A SKU is how the two halves stay joined. If the other app did not send one,
  // make a stable one from the supplier's item id so the same product coming
  // twice lands on the same row rather than making a duplicate.
  const sku = p.sku || (p.itemId ? `PS-${p.itemId}` : `PS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`);

  if (dryRun) {
    return {
      dryRun: true,
      sku,
      wouldCreate: { title: p.title, price: p.price, images: p.images.length, variants: p.variants.length },
      ...read,
    };
  }

  // The supply side: links, cost, images.
  taobao.saveItem({
    sku,
    url: p.url,
    variantUrl: p.variantUrl,
    title: p.title,
    price: p.cost ?? p.price,
    currency: p.currency,
    moq: p.moq,
    shippingCost: p.shippingCost,
    notes: p.notes,
    images: p.images,
  });

  // Pressing the button twice is normal - you fix something over there and send
  // it again. That must update the draft already on the desk rather than
  // leaving two of the same product behind. A draft already sent to Etsy is
  // left alone; a second push then starts a fresh one, which is right, because
  // the first is no longer a draft.
  const existing = getDb().prepare(`
    SELECT i.draft_id FROM product_studio_inbox i
    JOIN listing_drafts d ON d.listing_id = i.draft_id
    WHERE i.shop_id IS ? AND i.sku = ? AND d.pushed_at IS NULL`).get(activeShopId(), sku);

  const fields = {
    title: p.title.slice(0, 140),
    description: p.description,
    price: p.price ?? null,
    quantity: p.quantity,
    tags: p.tags,
    materials: p.materials,
    ...(p.taxonomyId ? { taxonomy_id: p.taxonomyId } : {}),
    who_made: 'someone_else',
    when_made: 'made_to_order',
  };

  // The Etsy side: a local draft, not a live listing.
  const draft = existing
    ? drafts.stage(existing.draft_id, fields)
    : drafts.createLocal(fields);

  // The photos (and video, if there is one) so the draft screen can actually
  // show them and they go up to Etsy the moment this becomes a real listing.
  // Resending the same product replaces what was staged rather than piling
  // more on, since a second press means "here is the corrected version".
  if (existing) draftmedia.clear(draft.listingId);
  for (const url of p.images.slice(0, draftmedia.MAX_IMAGES)) {
    try { draftmedia.addUrl(draft.listingId, { kind: 'image', url }); }
    catch (err) { log.warn(`could not stage image for draft ${draft.listingId}: ${err.message}`); }
  }
  if (p.videoUrl) {
    try { draftmedia.addUrl(draft.listingId, { kind: 'video', url: p.videoUrl }); }
    catch (err) { log.warn(`could not stage video for draft ${draft.listingId}: ${err.message}`); }
  }

  // Keep what came in, so the setup screen can show the mapping even after
  // the photos above have moved into draft_media.
  getDb().prepare(`
    INSERT INTO product_studio_inbox (draft_id, shop_id, sku, source, payload, images, variants, received_at)
    VALUES (?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(draft_id) DO UPDATE SET
      sku = excluded.sku, source = excluded.source, payload = excluded.payload,
      images = excluded.images, variants = excluded.variants, received_at = datetime('now')`)
    .run(draft.listingId, activeShopId(), sku, p.supplier,
      JSON.stringify(payload), JSON.stringify(p.images), JSON.stringify(p.variants));

  audit('productstudio.receive', { entity: 'listing', entityId: draft.listingId, detail: { sku, supplier: p.supplier } });
  log.info(`${p.supplier} product ${p.itemId ?? sku} arrived as draft ${draft.listingId}`);

  return {
    ok: true,
    sku,
    draftId: draft.listingId,
    updated: !!existing,
    // Where to look. Product Studio can open this to jump straight to it.
    openUrl: `http://localhost:${config.port}/drafts?open=${draft.listingId}`,
    title: p.title,
    images: p.images.length,
    variants: p.variants.length,
    understood: read.mapping,
    ignored: read.ignored,
    message: existing
      ? `"${p.title.slice(0, 60)}" was already on the draft desk, so it has been updated rather than added twice.`
      : `"${p.title.slice(0, 60)}" is on the draft desk. Nothing has gone to Etsy - open it, finish it, then send it.`,
  };
}

/** What came in with a draft: the photos and options Product Studio found. */
export function inboxFor(draftId) {
  const row = getDb().prepare('SELECT * FROM product_studio_inbox WHERE draft_id = ?').get(Number(draftId));
  if (!row) return null;
  const parse = (s, f) => { try { return JSON.parse(s ?? ''); } catch { return f; } };
  return {
    draftId: row.draft_id,
    sku: row.sku,
    source: row.source,
    images: parse(row.images, []),
    variants: parse(row.variants, []),
    payload: parse(row.payload, {}),
    receivedAt: row.received_at,
  };
}

// ------------------------------------------------------------------ pairing

/**
 * The shared key Product Studio sends with each product.
 *
 * The server listens on localhost, but so does every page in your browser, and
 * a web page can POST to localhost. Without a key, any site you happened to
 * have open could drop products onto your desk. It is generated once and shown
 * in the app for you to paste into Product Studio.
 */
export function pairingKey({ regenerate = false } = {}) {
  let key = readSetting('integrations.product_studio.key');
  if (!key || regenerate) {
    key = crypto.randomBytes(24).toString('base64url');
    writeSetting('integrations.product_studio.key', key);
    audit('productstudio.key', { detail: { regenerated: !!regenerate } });
  }
  return key;
}

/** Is this request allowed to add products? */
export function checkKey(given) {
  const expected = pairingKey();
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  // Same length or not, compare in constant time rather than with ===.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------------- drop folder

/** Where a file can be dropped instead of calling the endpoint. */
export const inboxDir = () => path.join(config.dataDir, 'product-studio-inbox');

/**
 * The no-code path.
 *
 * If Product Studio cannot be changed to call an endpoint, it can almost
 * certainly save a file. Anything dropped in this folder as .json is picked up,
 * turned into a draft, and moved aside so it is not read twice.
 */
export function scanInbox() {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'done'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'failed'), { recursive: true });

  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  const results = [];

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      // A file may hold one product or a list of them.
      for (const item of Array.isArray(raw) ? raw : [raw]) {
        results.push({ file, ...receive(item) });
      }
      fs.renameSync(full, path.join(dir, 'done', `${Date.now()}-${file}`));
    } catch (err) {
      results.push({ file, error: err.message });
      try { fs.renameSync(full, path.join(dir, 'failed', `${Date.now()}-${file}`)); } catch { /* leave it */ }
      log.warn(`${file}: ${err.message}`);
    }
  }

  return {
    scanned: files.length,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => r.error).length,
    folder: dir,
    results,
  };
}

/**
 * Everything Product Studio's author needs to wire the button up.
 *
 * Handed over as data rather than prose so the setup screen can show it and you
 * can copy it straight across.
 */
export function contract() {
  const port = config.port;
  const url = `http://localhost:${port}/api/integrations/product-studio/product`;
  const key = pairingKey();

  return {
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Product-Studio-Key': key },
    key,
    dropFolder: inboxDir(),
    // Only these two are required; everything else improves the draft.
    required: ['title', 'url'],
    accepts: Object.fromEntries(Object.entries(ALIASES).map(([field, names]) => [field, names])),
    example: {
      title: 'One Piece Theme Anime Artisan Keycap Set',
      description: 'Resin artisan keycap, MOA profile, fits Cherry MX.',
      sku: 'KC001-01',
      url: 'https://item.taobao.com/item.htm?id=1012415746554',
      variantUrl: 'https://item.taobao.com/item.htm?id=1012415746554&skuId=55',
      cost: 18.5,
      currency: 'CNY',
      price: 39.99,
      quantity: 10,
      images: ['https://img.alicdn.com/…/1.jpg', 'https://img.alicdn.com/…/2.jpg'],
      variants: [{ name: 'MOA Profile', sku: 'KC001-01', price: 18.5 }],
      tags: ['keycap', 'artisan', 'anime'],
    },
    snippets: {
      javascript: `// Product Studio: the "Etsy'e ekle" button
await fetch('${url}', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Product-Studio-Key': '${key}',
  },
  body: JSON.stringify(product),   // your product object, as it already is
});`,
      python: `import requests

requests.post(
    '${url}',
    headers={'X-Product-Studio-Key': '${key}'},
    json=product,   # your product dict, as it already is
    timeout=10,
)`,
      csharp: `using var http = new HttpClient();
http.DefaultRequestHeaders.Add("X-Product-Studio-Key", "${key}");
await http.PostAsJsonAsync("${url}", product);`,
    },
    notes: [
      'Send the product in whatever shape you already have. The field names it understands are listed above, in English, Chinese and Turkish.',
      'Add ?dryRun=1 to see how a payload would be read without creating anything.',
      'A product arrives as a draft. It never goes to Etsy on its own - you finish it here and press Send.',
      'If the button cannot make an HTTP request, write the same JSON as a file into the drop folder instead.',
    ],
  };
}
