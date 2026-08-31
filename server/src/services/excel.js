/**
 * Excel exports. Real .xlsx via ExcelJS: frozen headers, auto-filters, typed
 * cells (dates as dates, money as currency) and clickable tracking links, so
 * the file is usable as a working sheet rather than a dump.
 */
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import config from '../config.js';
import { getDb } from '../db/index.js';
import { listOrders, getOrder } from './orders.js';
import { skuGrid } from './inventory.js';
import { board as trackingBoard } from './tracking/index.js';
import { getDiscountPercent, trackingUrl } from './settings.js';
import { STATUS_LABELS } from './tracking/status.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const ALERT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
const DONE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };

const tsToDate = (ts) => (ts ? new Date(ts * 1000) : null);

function styleSheet(sheet, columns) {
  sheet.columns = columns;
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

function finalise(workbook) {
  workbook.creator = 'Etsy Command Center';
  workbook.created = new Date();
}

async function save(workbook, filename) {
  fs.mkdirSync(config.exportDir, { recursive: true });
  const file = path.join(config.exportDir, filename);
  await workbook.xlsx.writeFile(file);
  return { file, filename, bytes: fs.statSync(file).size };
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

// ------------------------------------------------------------------ orders

/**
 * Orders workbook: one summary sheet, one line-item sheet (one row per SKU
 * sold, which is what supplier ordering works from) and a tracking sheet.
 */
export async function exportOrders(filters = {}) {
  const { rows } = listOrders({ ...filters, limit: filters.limit ?? 5000, offset: 0 });
  const wb = new ExcelJS.Workbook();

  const orders = wb.addWorksheet('Orders', { properties: { defaultRowHeight: 18 } });
  styleSheet(orders, [
    { header: 'Done', key: 'done', width: 7 },
    { header: 'Order #', key: 'receiptId', width: 14 },
    { header: 'Placed', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Buyer', key: 'name', width: 24 },
    { header: 'Country', key: 'country', width: 9 },
    { header: 'City', key: 'city', width: 18 },
    { header: 'Items', key: 'items', width: 7 },
    { header: 'Total', key: 'total', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Paid', key: 'paid', width: 7 },
    { header: 'Shipped', key: 'shipped', width: 9 },
    { header: 'Canceled', key: 'canceled', width: 10 },
    { header: 'Tracking', key: 'tracking', width: 24 },
    { header: 'Carrier', key: 'carrier', width: 16 },
    { header: 'Tracking status', key: 'tstatus', width: 18 },
    { header: 'Days since move', key: 'days', width: 16 },
    { header: 'Alert', key: 'alert', width: 26 },
    { header: 'Buyer note', key: 'note', width: 40 },
    { header: 'Internal notes', key: 'notes', width: 30 },
  ]);

  for (const o of rows) {
    const row = orders.addRow({
      done: o.isDone ? 'YES' : '',
      receiptId: o.receiptId,
      created: tsToDate(o.createdTs),
      name: o.name,
      country: o.country,
      city: o.city,
      items: o.itemCount,
      total: o.total?.value ?? null,
      currency: o.total?.currency ?? '',
      paid: o.isPaid ? 'YES' : '',
      shipped: o.isShipped ? 'YES' : '',
      canceled: o.isCanceled ? 'YES' : '',
      tracking: o.trackingCode ?? '',
      carrier: o.carrier ?? '',
      tstatus: o.trackingStatusLabel ?? '',
      days: o.daysSinceMove ?? null,
      alert: o.alert ? o.alertReason : '',
      note: o.messageFromBuyer,
      notes: o.notes,
    });
    if (o.trackingCode) {
      row.getCell('tracking').value = { text: o.trackingCode, hyperlink: o.trackingUrl };
      row.getCell('tracking').font = { color: { argb: 'FF2563EB' }, underline: true };
    }
    if (o.alert) row.fill = ALERT_FILL;
    else if (o.isDone) row.fill = DONE_FILL;
  }

  // One row per sold line item, with the private supply link alongside.
  const items = wb.addWorksheet('Line items');
  styleSheet(items, [
    { header: 'Order #', key: 'receiptId', width: 14 },
    { header: 'Placed', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Buyer', key: 'buyer', width: 22 },
    { header: 'SKU', key: 'sku', width: 20 },
    { header: 'Title', key: 'title', width: 46 },
    { header: 'Variation', key: 'variation', width: 30 },
    { header: 'Qty', key: 'qty', width: 6 },
    { header: 'Unit price', key: 'price', width: 12 },
    { header: 'Line total', key: 'line', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Supplier', key: 'supplier', width: 18 },
    { header: 'Supply link', key: 'supply', width: 46 },
    { header: 'Supply cost', key: 'cost', width: 12 },
    { header: 'Tracking', key: 'tracking', width: 24 },
  ]);

  for (const o of rows) {
    let detail;
    try { detail = getOrder(o.receiptId); } catch { continue; }
    for (const i of detail.items) {
      const row = items.addRow({
        receiptId: o.receiptId,
        created: tsToDate(o.createdTs),
        buyer: o.name,
        sku: i.sku,
        title: i.title,
        variation: i.variationLabel,
        qty: i.quantity,
        price: i.price?.value ?? null,
        line: i.price?.value != null ? Math.round(i.price.value * i.quantity * 100) / 100 : null,
        currency: i.price?.currency ?? '',
        supplier: i.supplierName,
        supply: i.supplyLink,
        cost: i.supplyCost,
        tracking: o.trackingCode ?? '',
      });
      if (i.supplyLink) {
        row.getCell('supply').value = { text: i.supplyLink, hyperlink: i.supplyLink };
        row.getCell('supply').font = { color: { argb: 'FF2563EB' }, underline: true };
      }
    }
  }

  addTrackingSheet(wb);
  finalise(wb);
  return save(wb, `etsy-orders-${stamp()}.xlsx`);
}

function addTrackingSheet(wb) {
  const { rows } = trackingBoard({ limit: 5000 });
  const sheet = wb.addWorksheet('Tracking');
  styleSheet(sheet, [
    { header: 'Tracking', key: 'code', width: 24 },
    { header: 'Order #', key: 'receiptId', width: 14 },
    { header: 'Buyer', key: 'buyer', width: 22 },
    { header: 'Country', key: 'country', width: 9 },
    { header: 'Carrier', key: 'carrier', width: 16 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Last event', key: 'event', width: 44 },
    { header: 'Last event at', key: 'eventAt', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
    { header: 'Days since move', key: 'days', width: 16 },
    { header: 'Alert', key: 'alert', width: 30 },
    { header: 'Link', key: 'link', width: 46 },
  ]);
  for (const t of rows) {
    const row = sheet.addRow({
      code: t.trackingCode, receiptId: t.receiptId, buyer: t.buyerName, country: t.country,
      carrier: t.carrier, status: t.statusLabel, event: t.lastEventText,
      eventAt: t.lastEventAt ? new Date(t.lastEventAt) : null,
      days: t.daysSinceMove, alert: t.alert ? t.alertReason : '', link: t.trackingUrl,
    });
    row.getCell('link').value = { text: 'Open on YunTrack', hyperlink: t.trackingUrl };
    row.getCell('link').font = { color: { argb: 'FF2563EB' }, underline: true };
    if (t.alert) row.fill = ALERT_FILL;
  }
  return sheet;
}

export async function exportTracking() {
  const wb = new ExcelJS.Workbook();
  addTrackingSheet(wb);
  finalise(wb);
  return save(wb, `etsy-tracking-${stamp()}.xlsx`);
}

// -------------------------------------------------------------------- SKUs

/** The SKU sheet mirrors the on-screen grid, including both price columns. */
export async function exportSkus(filters = {}) {
  const pct = getDiscountPercent();
  const { rows } = skuGrid({ ...filters, limit: filters.limit ?? 10_000, offset: 0 });
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('SKUs');

  styleSheet(sheet, [
    { header: 'SKU', key: 'sku', width: 22 },
    { header: 'Title', key: 'title', width: 48 },
    { header: 'Variation', key: 'variation', width: 30 },
    { header: 'State', key: 'state', width: 10 },
    { header: 'Price (no discount)', key: 'full', width: 18 },
    { header: `Price (-${pct}%)`, key: 'disc', width: 16 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Qty', key: 'qty', width: 7 },
    { header: 'Enabled', key: 'enabled', width: 9 },
    { header: 'Supply link', key: 'supply', width: 46 },
    { header: 'Supplier', key: 'supplier', width: 18 },
    { header: 'Supply cost', key: 'cost', width: 12 },
    { header: 'Margin', key: 'margin', width: 10 },
    { header: 'Margin %', key: 'marginPct', width: 10 },
    { header: 'First image', key: 'image', width: 44 },
    { header: 'Variation image', key: 'vimage', width: 44 },
    { header: 'Listing ID', key: 'listingId', width: 14 },
    { header: 'Product ID', key: 'productId', width: 14 },
    { header: 'Listing URL', key: 'url', width: 40 },
  ]);

  for (const r of rows) {
    const row = sheet.addRow({
      sku: r.sku, title: r.title, variation: r.variation, state: r.state,
      full: r.priceFull, disc: r.priceDiscounted, currency: r.currency,
      qty: r.quantity, enabled: r.isEnabled ? 'YES' : 'NO',
      supply: r.supplyLink, supplier: r.supplierName, cost: r.supplyCost,
      margin: r.margin, marginPct: r.marginPercent,
      image: r.firstImageUrl, vimage: r.variationImageUrl,
      listingId: r.listingId, productId: r.productId, url: r.listingUrl,
    });
    for (const [key, url] of [['supply', r.supplyLink], ['image', r.firstImageUrl], ['vimage', r.variationImageUrl], ['url', r.listingUrl]]) {
      if (!url) continue;
      row.getCell(key).value = { text: url, hyperlink: url };
      row.getCell(key).font = { color: { argb: 'FF2563EB' }, underline: true };
    }
    if (!r.sku) row.getCell('sku').fill = ALERT_FILL;
  }

  finalise(wb);
  return save(wb, `etsy-skus-${stamp()}.xlsx`);
}

// ---------------------------------------------------------------- listings

export async function exportListings(filters = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (filters.state) { where.push('state = ?'); params.push(filters.state); }
  const rows = db.prepare(`SELECT * FROM listings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_ts DESC`).all(...params);

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Listings');
  styleSheet(sheet, [
    { header: 'Listing ID', key: 'id', width: 14 },
    { header: 'Title', key: 'title', width: 55 },
    { header: 'State', key: 'state', width: 10 },
    { header: 'Price', key: 'price', width: 12 },
    { header: `Price (-${getDiscountPercent()}%)`, key: 'disc', width: 16 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Qty', key: 'qty', width: 7 },
    { header: 'Views', key: 'views', width: 9 },
    { header: 'Favourites', key: 'favs', width: 11 },
    { header: 'Tags', key: 'tags', width: 60 },
    { header: 'Materials', key: 'materials', width: 30 },
    { header: 'Section', key: 'section', width: 12 },
    { header: 'Created', key: 'created', width: 18, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Updated', key: 'updated', width: 18, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'URL', key: 'url', width: 44 },
  ]);

  const pct = getDiscountPercent();
  for (const l of rows) {
    const price = l.price_amount != null ? l.price_amount / (l.price_divisor || 100) : null;
    const row = sheet.addRow({
      id: l.listing_id, title: l.title, state: l.state, price,
      disc: price != null ? Math.round(price * (1 - pct / 100) * 100) / 100 : null,
      currency: l.price_currency, qty: l.quantity, views: l.views, favs: l.num_favorers,
      tags: (JSON.parse(l.tags || '[]') || []).join(', '),
      materials: (JSON.parse(l.materials || '[]') || []).join(', '),
      section: l.shop_section_id,
      created: tsToDate(l.created_ts), updated: tsToDate(l.updated_ts), url: l.url,
    });
    if (l.url) {
      row.getCell('url').value = { text: 'Open', hyperlink: l.url };
      row.getCell('url').font = { color: { argb: 'FF2563EB' }, underline: true };
    }
  }
  finalise(wb);
  return save(wb, `etsy-listings-${stamp()}.xlsx`);
}

/** Blank sheet the operator fills in and re-uploads for bulk tracking. */
export async function exportTrackingTemplate() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Add tracking');
  styleSheet(sheet, [
    { header: 'receipt_id', key: 'receipt', width: 16 },
    { header: 'tracking_code', key: 'code', width: 26 },
    { header: 'carrier_name', key: 'carrier', width: 20 },
    { header: 'Buyer (reference)', key: 'buyer', width: 24 },
    { header: 'Placed (reference)', key: 'placed', width: 18, style: { numFmt: 'yyyy-mm-dd' } },
  ]);
  // Pre-fill the orders that still need a number so it is fill-in-the-blank.
  const pending = listOrders({ hasTracking: false, canceled: false, limit: 2000 }).rows;
  for (const o of pending) {
    sheet.addRow({ receipt: o.receiptId, code: '', carrier: '', buyer: o.name, placed: tsToDate(o.createdTs) });
  }
  finalise(wb);
  return save(wb, `etsy-tracking-template-${stamp()}.xlsx`);
}

export function listExports() {
  fs.mkdirSync(config.exportDir, { recursive: true });
  return fs.readdirSync(config.exportDir)
    .filter((f) => f.endsWith('.xlsx'))
    .map((f) => {
      const s = fs.statSync(path.join(config.exportDir, f));
      return { filename: f, bytes: s.size, createdAt: s.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export { STATUS_LABELS, trackingUrl };
