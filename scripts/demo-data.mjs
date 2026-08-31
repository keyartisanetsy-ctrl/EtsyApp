/**
 * Loads a small, obviously-fake dataset so the screens can be explored before
 * connecting a real shop. Nothing here ever touches Etsy.
 *
 *   node scripts/demo-data.mjs         load
 *   node scripts/demo-data.mjs --clear remove it again
 */
import { getDb } from '../server/src/db/index.js';

const db = getDb();
const clear = process.argv.includes('--clear');

// Demo rows use ids in a reserved band so they are easy to remove cleanly.
const L = [9900001, 9900002, 9900003];
const R = [8800001, 8800002, 8800003, 8800004];

if (clear) {
  db.transaction(() => {
    for (const id of L) {
      db.prepare('DELETE FROM listing_products WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM listing_images WHERE listing_id = ?').run(id);
      db.prepare('DELETE FROM listings WHERE listing_id = ?').run(id);
    }
    for (const id of R) {
      db.prepare('DELETE FROM receipt_transactions WHERE receipt_id = ?').run(id);
      db.prepare('DELETE FROM order_flags WHERE receipt_id = ?').run(id);
      db.prepare('DELETE FROM shipments WHERE receipt_id = ?').run(id);
      db.prepare('DELETE FROM receipts WHERE receipt_id = ?').run(id);
    }
    db.prepare("DELETE FROM tracking WHERE tracking_code LIKE 'DEMO%'").run();
    db.prepare("DELETE FROM tracking_events WHERE tracking_code LIKE 'DEMO%'").run();
    db.prepare("DELETE FROM sku_meta WHERE sku LIKE 'KA-DEMO%'").run();
  })();
  console.log('demo data removed');
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
// Inline SVG data URIs so the demo renders with no network at all.
const img = (seed) => {
  const label = String(seed).slice(0, 10).replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="570" height="570">`
    + `<rect width="570" height="570" fill="#1d2b47"/>`
    + `<text x="285" y="300" font-family="sans-serif" font-size="52" fill="#93a4c4" `
    + `text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};

const listings = [
  { id: L[0], title: 'Personalised Leather Keyring, Hand-Stamped Initials', state: 'active', price: 2400, qty: 42, tags: ['leather keyring', 'personalised gift', 'hand stamped'], section: 1 },
  { id: L[1], title: 'Minimalist Brass Candle Holder, Matte Finish', state: 'active', price: 3800, qty: 17, tags: ['brass decor', 'candle holder'], section: 1 },
  { id: L[2], title: 'Linen Apron with Pockets, Stonewashed', state: 'draft', price: 5200, qty: 8, tags: ['linen apron'], section: null },
];

const variations = [
  { listing: L[0], pid: 7700001, sku: 'KA-DEMO-KEY-BLK', label: 'Colour: Black / Font: Serif', price: 2400, qty: 20 },
  { listing: L[0], pid: 7700002, sku: 'KA-DEMO-KEY-TAN', label: 'Colour: Tan / Font: Serif', price: 2400, qty: 14 },
  { listing: L[0], pid: 7700003, sku: '', label: 'Colour: Navy / Font: Script', price: 2600, qty: 8 },
  { listing: L[1], pid: 7700004, sku: 'KA-DEMO-CND-SM', label: 'Size: Small', price: 3800, qty: 9 },
  { listing: L[1], pid: 7700005, sku: 'KA-DEMO-CND-LG', label: 'Size: Large', price: 4900, qty: 8 },
  { listing: L[2], pid: 7700006, sku: 'KA-DEMO-APR-NAT', label: 'Colour: Natural', price: 5200, qty: 8 },
];

const orders = [
  { id: R[0], name: 'A. Demo-Buyer', city: 'Hamburg', country: 'DE', total: 4800, created: now - 2 * 86400, shipped: 1, done: 0, seen: 0, track: 'DEMO0000000001', status: 'in_transit', idleDays: 1 },
  { id: R[1], name: 'B. Sample', city: 'Lyon', country: 'FR', total: 3800, created: now - 9 * 86400, shipped: 1, done: 0, seen: 1, track: 'DEMO0000000002', status: 'in_transit', idleDays: 7 },
  { id: R[2], name: 'C. Placeholder', city: 'Austin', country: 'US', total: 7600, created: now - 21 * 86400, shipped: 1, done: 1, seen: 1, track: 'DEMO0000000003', status: 'delivered', idleDays: 0 },
  { id: R[3], name: 'D. Example', city: 'Leeds', country: 'GB', total: 2400, created: now - 6 * 3600, shipped: 0, done: 0, seen: 0, track: null },
];

db.transaction(() => {
  for (const l of listings) {
    db.prepare(`INSERT OR REPLACE INTO listings (listing_id, shop_id, title, description, state, url,
      price_amount, price_divisor, price_currency, quantity, taxonomy_id, shop_section_id, tags, materials,
      views, num_favorers, created_ts, updated_ts, first_image_url, raw)
      VALUES (?,?,?,?,?,?,?,100,'EUR',?,1,?,?,'[]',?,?,?,?,?,'{}')`)
      .run(l.id, 1, l.title, `Demo listing. ${l.title}.`, l.state,
        `https://www.etsy.com/listing/${l.id}`, l.price, l.qty, l.section,
        JSON.stringify(l.tags), 100 + (l.id % 900), 10 + (l.id % 90),
        now - 120 * 86400, now - 3 * 86400, img(l.title.split(' ')[0]));

    db.prepare(`INSERT OR REPLACE INTO listing_images (listing_image_id, listing_id, rank, url_570xN, url_fullxfull)
      VALUES (?,?,1,?,?)`).run(l.id * 10, l.id, img(l.title.split(' ')[0]), img(l.title.split(' ')[0]));
  }

  for (const v of variations) {
    db.prepare(`INSERT OR REPLACE INTO listing_products (product_id, listing_id, sku, is_deleted,
      property_values, variation_label, price_amount, price_divisor, price_currency, quantity,
      is_enabled, variation_image_url, raw)
      VALUES (?,?,?,0,'[]',?,?,100,'EUR',?,1,?,'{}')`)
      .run(v.pid, v.listing, v.sku, v.label, v.price, v.qty, img(v.label.split(' ')[1] ?? 'V'));
  }

  for (const [sku, link, cost] of [
    ['KA-DEMO-KEY-BLK', 'https://supplier.example/leather-keyring-black', 6.2],
    ['KA-DEMO-KEY-TAN', 'https://supplier.example/leather-keyring-tan', 6.2],
    ['KA-DEMO-CND-SM', 'https://supplier.example/brass-holder-small', 11.4],
  ]) {
    db.prepare(`INSERT OR REPLACE INTO sku_meta (sku, supply_link, supplier_name, supply_cost, supply_currency, lead_time_days, notes)
      VALUES (?,?,'Demo Supplier Co',?,'EUR',12,'')`).run(sku, link, cost);
  }

  for (const o of orders) {
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, status, name, city, country_iso,
      formatted_address, first_line, zip, message_from_buyer, is_paid, is_shipped, was_paid, was_shipped,
      was_delivered, was_canceled, grandtotal_amount, grandtotal_divisor, grandtotal_currency,
      subtotal_amount, total_shipping_amount, created_ts, updated_ts, raw)
      VALUES (?,1,'Completed',?,?,?,?,'1 Example Street','00000',?,1,?,1,?,?,0,?,100,'EUR',?,0,?,?,'{}')`)
      .run(o.id, o.name, o.city, o.country, `1 Example Street, ${o.city}, ${o.country}`,
        o.id === R[1] ? 'Hi! Any update on my parcel? It has not moved in a while.' : '',
        o.shipped, o.shipped, o.status === 'delivered' ? 1 : 0,
        o.total, o.total, o.created, o.created);

    db.prepare('INSERT OR REPLACE INTO order_flags (receipt_id, is_done, is_seen) VALUES (?,?,?)')
      .run(o.id, o.done, o.seen);

    db.prepare(`INSERT OR REPLACE INTO receipt_transactions (transaction_id, receipt_id, listing_id,
      product_id, sku, title, quantity, price_amount, price_divisor, price_currency, variations, image_url, raw)
      VALUES (?,?,?,?,?,?,1,?,100,'EUR','[]',?,'{}')`)
      .run(o.id * 10, o.id, variations[0].listing, variations[0].pid, variations[0].sku,
        listings[0].title, o.total, img('Item'));

    if (!o.track) continue;

    db.prepare('INSERT OR REPLACE INTO shipments (receipt_id, tracking_code, carrier_name, pushed_to_etsy) VALUES (?,?,?,1)')
      .run(o.id, o.track, 'YunExpress');

    const lastEvent = new Date((now - o.idleDays * 86400) * 1000).toISOString();
    const stale = o.idleDays >= 4 && o.status !== 'delivered';
    db.prepare(`INSERT OR REPLACE INTO tracking (tracking_code, receipt_id, carrier_name, provider, status,
      status_detail, last_event_at, last_event_text, last_event_location, event_count, days_since_move,
      is_stale, alert_reason, delivered_at, last_checked_at, raw)
      VALUES (?,?,'YunExpress','manual',?,?,?,?,?,2,?,?,?,?,datetime('now'),'{}')`)
      .run(o.track, o.id, o.status, 'Demo record',
        lastEvent,
        o.status === 'delivered' ? 'Delivered, signed for' : 'Departed from sorting centre',
        o.country, o.idleDays, stale ? 1 : 0,
        stale ? `No movement for ${o.idleDays} days` : '',
        o.status === 'delivered' ? lastEvent : null);

    for (const [i, text] of ['Departed from sorting centre', 'Electronic information received'].entries()) {
      db.prepare(`INSERT OR IGNORE INTO tracking_events (tracking_code, event_at, description, location, fingerprint)
        VALUES (?,?,?,?,?)`)
        .run(o.track, new Date((now - (o.idleDays + i * 3) * 86400) * 1000).toISOString(), text, o.country, `${o.track}-${i}`);
    }
  }
})();

console.log('demo data loaded:');
console.log(`  ${listings.length} listings, ${variations.length} variations, ${orders.length} orders, 3 tracked parcels`);
console.log('  one parcel is deliberately stale so the alert path is visible');
console.log('\nremove it again with:  node scripts/demo-data.mjs --clear');
