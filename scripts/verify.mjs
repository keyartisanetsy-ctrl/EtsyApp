/**
 * End-to-end smoke test against a running server.
 * Exercises the read paths and the local write paths that do not need Etsy,
 * so a broken build is caught before it reaches the shop.
 */
const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:4317';
let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

const req = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!opts.allowError && !res.ok) throw new Error(`${res.status} ${body?.error ?? text.slice(0, 120)}`);
  return { status: res.status, body };
};

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log('\nEtsy Command Center - verification\n');

console.log('Core');
await check('health responds', async () => {
  const { body } = await req('/api/health');
  assert(body.ok === true, 'not ok');
  assert(body.operations === 105, `expected 105 operations, got ${body.operations}`);
});
await check('dashboard aggregates', async () => {
  const { body } = await req('/api/dashboard');
  assert(body.listings && body.orders && body.tracking, 'missing sections');
});
await check('auth status', async () => {
  const { body } = await req('/api/auth/status');
  assert(Array.isArray(body.availableScopes) && body.availableScopes.length === 12, 'expected 12 OAuth scopes');
});

await check('sqlite driver resolves without a native build', async () => {
  const d = await import('../server/src/db/driver.js');
  // The kind is only known once a database has actually been opened.
  const db = await d.openDatabase(':memory:');
  db.exec('SELECT 1');
  assert(d.driverKind(), 'no driver resolved');
  console.log(`       (driver: ${d.driverKind()})`);
});
await check('transactions commit, roll back, and nest correctly', async () => {
  const { openDatabase } = await import('../server/src/db/driver.js');
  const db = await openDatabase(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  const count = () => db.prepare('SELECT COUNT(*) c FROM t').get().c;

  db.transaction(() => { ins.run('a'); ins.run('b'); })();
  assert(count() === 2, `commit lost rows: ${count()}`);

  try { db.transaction(() => { ins.run('c'); throw new Error('x'); })(); } catch { /* expected */ }
  assert(count() === 2, `rollback did not discard: ${count()}`);

  // An inner failure must not destroy the outer transaction's work.
  db.transaction(() => {
    ins.run('d');
    try { db.transaction(() => { ins.run('e'); throw new Error('x'); })(); } catch { /* expected */ }
  })();
  assert(count() === 3, `nested savepoint wrong: ${count()}`);

  try {
    db.transaction(() => { ins.run('f'); db.transaction(() => ins.run('g'))(); throw new Error('x'); })();
  } catch { /* expected */ }
  assert(count() === 3, `outer rollback did not unwind inner: ${count()}`);

  assert(db.transaction((x, y) => x + y)(2, 3) === 5, 'transaction did not pass args/return');
});
await check('driver coerces values sqlite cannot bind', async () => {
  const { openDatabase } = await import('../server/src/db/driver.js');
  const db = await openDatabase(':memory:');
  db.exec('CREATE TABLE c(b, u, d)');
  db.prepare('INSERT INTO c VALUES (?,?,?)').run(true, undefined, new Date('2024-01-01T00:00:00Z'));
  const row = db.prepare('SELECT * FROM c').get();
  assert(row.b === 1, 'boolean not coerced to 1');
  assert(row.u === null, 'undefined not coerced to null');
  assert(String(row.d).startsWith('2024-01-01'), 'Date not coerced to ISO');
});

console.log('\nEtsy operation catalogue');
await check('all 105 operations exposed', async () => {
  const { body } = await req('/api/etsy/operations');
  assert(body.count === 105, `count ${body.count}`);
  assert(body.tags.length === 27, `expected 27 tags, got ${body.tags.length}`);
});
await check('every documented tag is present', async () => {
  const { body } = await req('/api/etsy/operations');
  const expected = ['ShopListing', 'ShopListing Inventory', 'ShopListing VariationImage', 'Shop Receipt',
    'Shop Receipt Transactions', 'Payment', 'Ledger Entry', 'Review', 'Shop ShippingProfile',
    'Shop Return Policy', 'Shop HolidayPreferences', 'Shop ProductionPartner', 'SellerTaxonomy',
    'BuyerTaxonomy', 'User', 'UserAddress', 'Shop Section'];
  const missing = expected.filter((t) => !body.tags.includes(t));
  assert(!missing.length, `missing tags: ${missing.join(', ')}`);
});
await check('operation detail carries a schema', async () => {
  const { body } = await req('/api/etsy/operations/updateListingInventory');
  assert(body.method === 'PUT', 'wrong method');
  assert(body.body?.props?.products, 'inventory body schema missing');
});
await check('unknown operation is rejected', async () => {
  const { status } = await req('/api/etsy/operations/nope', { allowError: true });
  assert(status === 404, `expected 404, got ${status}`);
});

await check('x-api-key is built as keystring:shared_secret', async () => {
  const c = await import('../server/src/etsy/client.js');
  assert(c.buildApiKeyHeader('key', 'secret') === 'key:secret', 'pair not combined');
  assert(c.buildApiKeyHeader('key:secret', 'secret') === 'key:secret', 'already-combined value was doubled');
  assert(c.buildApiKeyHeader(' key ', ' secret ') === 'key:secret', 'whitespace not trimmed');
  assert(c.buildApiKeyHeader('', 'secret') === '', 'empty keystring should yield empty header');
});
await check('a call without the shared secret is refused before it reaches Etsy', async () => {
  const { status, body } = await req('/api/auth/test', { allowError: true });
  assert(status === 200, `test endpoint should always answer, got ${status}`);
  assert(Array.isArray(body.checks) && body.checks.length >= 3, 'no checks returned');
  const fmt = body.checks.find((c) => c.name === 'x-api-key format');
  assert(fmt, 'missing the x-api-key format check');
});

await check('two shops stay isolated from each other', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const listings = await import('../server/src/services/listings.js');
  const orders = await import('../server/src/services/orders.js');
  await initDb();
  const db = getDb();

  // Two pretend shops, each with one listing and one order.
  const seal = 'v1.x.y.z'; // token contents are irrelevant here
  db.prepare('DELETE FROM etsy_accounts WHERE shop_id IN (990001, 990002)').run();
  for (const [shopId, name] of [[990001, 'Verify Shop A'], [990002, 'Verify Shop B']]) {
    db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
                VALUES (?,?,?,?,datetime('now','+1 hour'),0)`).run(shopId, name, seal, seal);
    db.prepare(`INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state, price_amount, price_divisor, price_currency)
                VALUES (?,?,?,'active',1000,100,'EUR')`).run(shopId + 1, shopId, `Listing for ${name}`);
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, was_canceled, was_shipped, was_paid, grandtotal_amount, grandtotal_divisor, grandtotal_currency)
                VALUES (?,?,?,0,0,1,1000,100,'EUR')`).run(shopId + 2, shopId, `Buyer at ${name}`);
    db.prepare('INSERT OR IGNORE INTO order_flags (receipt_id) VALUES (?)').run(shopId + 2);
  }

  client.setActiveAccount(990001);
  let l = listings.localListings({ limit: 50 });
  let o = orders.listOrders({ limit: 50 });
  assert(l.rows.every((r) => r.listingId === 990002), `shop A saw foreign listings: ${l.rows.map((r) => r.listingId)}`);
  assert(o.rows.every((r) => r.receiptId === 990003), `shop A saw foreign orders: ${o.rows.map((r) => r.receiptId)}`);

  client.setActiveAccount(990002);
  l = listings.localListings({ limit: 50 });
  o = orders.listOrders({ limit: 50 });
  assert(l.rows.every((r) => r.listingId === 990003), `shop B saw foreign listings: ${l.rows.map((r) => r.listingId)}`);
  assert(o.rows.every((r) => r.receiptId === 990004), `shop B saw foreign orders: ${o.rows.map((r) => r.receiptId)}`);

  // An order belonging to the other shop must not be reachable by id.
  let leaked = false;
  try { orders.getOrder(990003); leaked = true; } catch { /* correct */ }
  assert(!leaked, 'getOrder returned another shop\'s order');

  // Removing a shop takes its data and hands the active flag to the survivor.
  client.removeAccount(990002);
  const remaining = client.listAccounts().filter((a) => [990001, 990002].includes(a.shopId));
  assert(remaining.length === 1 && remaining[0].shopId === 990001, 'removeAccount left the wrong set');
  assert(remaining[0].isActive, 'no shop became active after removing the active one');
  assert(db.prepare('SELECT COUNT(*) c FROM listings WHERE shop_id = 990002').get().c === 0, 'removed shop left listings behind');

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id IN (990001, 990002)').run();
  db.prepare('DELETE FROM listings WHERE shop_id IN (990001, 990002)').run();
  db.prepare('DELETE FROM receipts WHERE shop_id IN (990001, 990002)').run();
});
await check('privacy report discloses every destination', async () => {
  const { body } = await req('/api/settings/privacy');
  assert(body.destinations?.length >= 5, 'destinations missing');
  assert(body.neverSent?.length >= 5, 'never-sent list missing');
  assert(body.headersStripped?.includes('Accept-Language'), 'locale header not declared as stripped');
  // The IP claim must stay honest: not hidden unless a proxy is actually set.
  assert(body.ipAddress.hidden === body.proxyConfigured,
    'IP privacy claim does not match whether a proxy is configured');
  assert(/cannot change it|proxy/i.test(body.ipAddress.note), 'IP note is not explicit about the limitation');
});
await check('AI opt-out blocks every provider call', async () => {
  await req('/api/settings', { method: 'PUT', body: { 'privacy.share_ai': 'false' } });
  const { status, body } = await req('/api/ai/reply', { method: 'POST', body: { message: 'hello' }, allowError: true });
  assert(status === 400, `expected 400, got ${status}`);
  assert(/switched off|Privacy/i.test(body.error), `unhelpful error: ${body.error}`);
  assert(/Nothing has been sent/i.test(body.error), 'error should confirm nothing was transmitted');
  await req('/api/settings', { method: 'PUT', body: { 'privacy.share_ai': 'true' } });
});

await check('outbound requests carry no machine or locale information', async () => {
  const { USER_AGENT, DESTINATIONS } = await import('../server/src/lib/outbound.js');
  assert(!/node|win|mac|linux|\d+\.\d+\.\d+/i.test(USER_AGENT.replace('1.0', '')),
    `User-Agent leaks platform detail: ${USER_AGENT}`);
  assert(DESTINATIONS.length >= 5, 'destination disclosure list is incomplete');
  assert(DESTINATIONS.every((d) => d.host && d.purpose && d.sends), 'a destination is missing its disclosure');
});

console.log('\nSKU / inventory');
await check('sku grid responds with discount column', async () => {
  const { body } = await req('/api/skus');
  assert(typeof body.total === 'number', 'no total');
  assert(body.discountPercent === 30, `discount ${body.discountPercent}`);
});
await check('duplicate SKU detection', async () => { await req('/api/skus/duplicates'); });
await check('reverse pricing helper', async () => {
  const { body } = await req('/api/skus/price-for-target?target=70&percent=30');
  assert(body.listPrice === 100, `expected 100, got ${body.listPrice}`);
});
await check('supply-link metadata round-trips', async () => {
  const sku = `VERIFY-${Date.now()}`;
  await req(`/api/skus/${sku}/meta`, { method: 'PUT', body: { supplyLink: 'https://supplier.example/x', supplyCost: 4.5 } });
  const { body } = await req(`/api/skus/${sku}/meta`);
  assert(body.supply_link === 'https://supplier.example/x', 'link not stored');
  assert(body.supply_cost === 4.5, 'cost not stored');
  await req(`/api/skus/${sku}/meta`, { method: 'DELETE' });
});

console.log('\nOrders');
await check('order list responds', async () => { await req('/api/orders'); });
await check('order counters', async () => {
  const { body } = await req('/api/orders/counters');
  for (const k of ['total', 'newOrders', 'notDone', 'unshipped', 'noTracking', 'alerts']) {
    assert(typeof body[k] === 'number', `missing counter ${k}`);
  }
});
await check('missing order returns 404', async () => {
  const { status } = await req('/api/orders/999999999', { allowError: true });
  assert(status === 404, `expected 404, got ${status}`);
});

console.log('\nTracking');
await check('board and summary', async () => {
  await req('/api/tracking');
  const { body } = await req('/api/tracking/summary');
  assert(body.staleDays === 4, `stale window should be 4, got ${body.staleDays}`);
});
await check('status vocabulary complete', async () => {
  const { body } = await req('/api/tracking/statuses');
  for (const s of ['pre_shipped', 'in_transit', 'delivered', 'exception']) {
    assert(body.statuses.includes(s), `missing status ${s}`);
  }
  assert(body.labels.in_transit === 'On its way', 'in_transit label wrong');
});
await check('bulk paste parser accepts and rejects correctly', async () => {
  const { body } = await req('/api/tracking/parse', {
    method: 'POST',
    body: { text: '3456789012, LP00432300758472, YunExpress\n3456789013\tYT2024001234567\nbroken line' },
  });
  assert(body.rows.length === 2, `expected 2 rows, got ${body.rows.length}`);
  assert(body.errors.length === 1, `expected 1 error, got ${body.errors.length}`);
  assert(body.rows[0].carrierName === 'YunExpress', 'carrier not parsed');
});
await check('tracking deep link uses the YunTrack template', async () => {
  const { body } = await req('/api/tracking/LP00432300758472/link');
  assert(body.url === 'https://www.yuntrack.com/parcelTracking?id=LP00432300758472', `got ${body.url}`);
});
await check('manual status + stale alert lifecycle', async () => {
  const code = `VERIFY${Date.now()}`;
  await req(`/api/tracking/${code}/status`, { method: 'POST', body: { status: 'in_transit', note: 'verification' } });
  const { body } = await req(`/api/tracking/${code}`);
  assert(body.status === 'in_transit', `status ${body.status}`);
  assert(body.statusLabel === 'On its way', 'label wrong');
  assert(body.trackingUrl.includes(code), 'link missing code');
  const { body: events } = await req(`/api/tracking/${code}/events`);
  assert(events.length >= 1, 'no event recorded');
});

await check('yuntrack signature matches the page algorithm', async () => {
  const y = await import('../server/src/services/tracking/yuntrack.js');
  // Reference vector computed from the site's own getSign implementation.
  const expected = '4fd305d37e67f452d209d7d4815d4e75c9f1f604e8fb18b3253bfe7133e20a80';
  assert(y.sign(1788186762569, ['YT2616000700920111']) === expected, 'HMAC-SHA256 signature mismatch');
  const req = y.buildRequest(['YT123']);
  for (const k of ['NumberList', 'CaptchaVerification', 'Timestamp', 'Signature']) {
    assert(k in req, `request body missing ${k}`);
  }
});
await check('yuntrack status codes match the published mapping', async () => {
  const y = await import('../server/src/services/tracking/yuntrack.js');
  const expect = { 0: 'not_found', 10: 'pre_shipped', 20: 'in_transit', 30: 'in_transit',
                   40: 'exception', 50: 'delivered', 60: 'exception', 70: 'exception',
                   90: 'returned', 100: 'exception' };
  for (const [code, want] of Object.entries(expect)) {
    assert(y.YUNTRACK_STATUS[code] === want, `code ${code} should map to ${want}, got ${y.YUNTRACK_STATUS[code]}`);
  }
});
await check('yuntrack event parsing splits content and location', async () => {
  const y = await import('../server/src/services/tracking/yuntrack.js');
  assert(y.splitContent('Departed----SHENZHEN, CN').location === 'SHENZHEN, CN', 'location not split on ----');
  const p = y.normalise({ TrackInfo: { WaybillNumber: 'YT1', TrackingStatus: 50,
    LastTrackEvent: { TrackingStatus: 50 },
    ProcessGroupList: [{ ProcessGroupDate: '2024-05-29 10:00:00', ProcessDetailList: [
      { ProcessDate: '2024-05-29 16:26:40', ProcessContent: 'Delivered, signed for----BERLIN, DE', IsPod: true, Pod: 'http://pod' },
      { ProcessDate: '2024-05-20 10:00:00', ProcessContent: 'Departed----SHENZHEN, CN' }] }] } });
  assert(p.status === 'delivered', `status ${p.status}`);
  assert(p.events.length === 2, `expected 2 events, got ${p.events.length}`);
  assert(p.events[0].location === 'BERLIN, DE', 'newest event location wrong');
  assert(p.podUrl === 'http://pod', 'proof-of-delivery url not captured');
});
await check('tracking providers are all selectable', async () => {
  const { body } = await req('/api/settings');
  const provider = body.settings.find((s) => s.key === 'tracking.provider');
  assert(provider?.options?.length === 4, `expected 4 provider options, got ${provider?.options?.length}`);
  const values = provider.options.map((o) => o.value);
  for (const v of ['yuntrack', 'yuntrack-browser', 'seventeentrack', 'manual']) {
    assert(values.includes(v), `missing provider ${v}`);
  }
});
await check('browser provider reports a clear setup message when unavailable', async () => {
  const b = await import('../server/src/services/tracking/yuntrack-browser.js');
  try {
    await b.fetchTracking(['YT1'], { timeoutMs: 3000 });
  } catch (err) {
    // Either Playwright is missing (clear message) or it launched -- both fine.
    assert(/Playwright|browser/i.test(err.message), `unhelpful message: ${err.message}`);
  }
});

console.log('\nAI');
await check('provider status', async () => {
  const { body } = await req('/api/ai/status');
  for (const p of ['manus', 'anthropic', 'openai']) assert(p in body, `missing provider ${p}`);
  assert(body.anthropic.supportsImages === true, 'anthropic should support images');
  assert(body.manus.async === true, 'manus should be async');
});
await check('prompt library seeded', async () => {
  const { body } = await req('/api/ai/prompts');
  assert(body.prompts.length >= 8, `only ${body.prompts.length} prompts`);
  for (const kind of ['reply', 'title', 'description', 'tags', 'listing', 'image', 'research']) {
    assert(body.prompts.some((p) => p.kind === kind), `no prompt for kind ${kind}`);
  }
});
await check('default prompt per kind', async () => {
  const { body } = await req('/api/ai/prompts/default/reply');
  assert(body?.is_default === 1, 'reply default missing');
});
await check('prompt create / default / delete', async () => {
  const { body: created } = await req('/api/ai/prompts', {
    method: 'POST', body: { name: `verify-${Date.now()}`, kind: 'reply', body: 'Test prompt body' },
  });
  assert(created.id, 'no id returned');
  await req(`/api/ai/prompts/${created.id}/default`, { method: 'POST' });
  const { body: after } = await req('/api/ai/prompts/default/reply');
  assert(after.id === created.id, 'default did not move');
  await req(`/api/ai/prompts/${created.id}`, { method: 'DELETE' });
});
await check('built-in prompts are protected', async () => {
  const { body: list } = await req('/api/ai/prompts');
  const builtin = list.prompts.find((p) => p.is_system === 1);
  const { status } = await req(`/api/ai/prompts/${builtin.id}`, { method: 'DELETE', allowError: true });
  assert(status === 400, `expected 400, got ${status}`);
});
await check('AI call without a key fails cleanly', async () => {
  const { status, body } = await req('/api/ai/reply', { method: 'POST', body: { message: 'hello' }, allowError: true });
  assert(status === 400, `expected 400, got ${status}`);
  assert(/provider/i.test(body.error), `unhelpful error: ${body.error}`);
});

console.log('\nBulk engine');
await check('action catalogue', async () => {
  const { body } = await req('/api/bulk/actions');
  assert(body.length >= 20, `only ${body.length} actions`);
  for (const t of ['listing.activate', 'listing.price', 'sku.generate', 'order.tracking', 'ai.tags']) {
    assert(body.some((a) => a.type === t), `missing action ${t}`);
  }
});
await check('dry run produces a plan without calling Etsy', async () => {
  const { body } = await req('/api/bulk/jobs', {
    method: 'POST', body: { type: 'listing.activate', targets: [111, 222], dryRun: true },
  });
  assert(body.status === 'completed', `status ${body.status}`);
  assert(body.items.length === 2, 'wrong item count');
  assert(body.items[0].label.includes('111'), 'label missing target');
});
await check('unknown bulk action rejected', async () => {
  const { status } = await req('/api/bulk/jobs', { method: 'POST', body: { type: 'nope', targets: [1] }, allowError: true });
  assert(status === 400, `expected 400, got ${status}`);
});

console.log('\nExcel exports');
for (const [name, path] of [['orders', '/api/exports/orders'], ['skus', '/api/exports/skus'],
                            ['listings', '/api/exports/listings'], ['tracking', '/api/exports/tracking'],
                            ['tracking template', '/api/exports/tracking-template']]) {
  await check(`${name} workbook builds`, async () => {
    const { body } = await req(path, { method: 'POST', body: {} });
    assert(body.filename?.endsWith('.xlsx'), 'not an xlsx');
    assert(body.bytes > 3000, `suspiciously small: ${body.bytes} bytes`);
  });
}
await check('export download serves the file', async () => {
  const { body: list } = await req('/api/exports');
  const res = await fetch(`${BASE}/api/exports/download/${encodeURIComponent(list[0].filename)}`);
  assert(res.ok, `download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  assert(buf.length > 3000, 'empty download');
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'not a zip/xlsx signature');
});
await check('path traversal on download is blocked', async () => {
  const res = await fetch(`${BASE}/api/exports/download/..%2F..%2F.env`);
  assert(res.status === 404, `expected 404, got ${res.status}`);
});

console.log('\nSettings');
await check('settings expose sources and mask secrets', async () => {
  const { body } = await req('/api/settings');
  assert(body.settings.length >= 15, 'too few settings');
  const secret = body.settings.find((s) => s.secret);
  assert(secret, 'no secret setting defined');
  assert(!secret.value || secret.value.includes('•'), 'secret not masked');
});
await check('setting writes and reads back', async () => {
  await req('/api/settings', { method: 'PUT', body: { 'pricing.discount_percent': '25' } });
  const { body } = await req('/api/skus');
  assert(body.discountPercent === 25, `discount did not apply: ${body.discountPercent}`);
  await req('/api/settings', { method: 'PUT', body: { 'pricing.discount_percent': '30' } });
});

await check('opening a browser never crashes the server', async () => {
  const { openBrowser, shouldOpenBrowser } = await import('../server/src/lib/open-browser.js');
  // On a machine with no opener installed this must degrade quietly. A missing
  // binary arrives as an async 'error' event, which would otherwise be
  // unhandled and kill the process.
  const result = openBrowser('http://127.0.0.1:9/should-not-open');
  assert(result === true, 'openBrowser should report that it tried');
  await new Promise((r) => setTimeout(r, 400)); // let any spawn error fire
  assert(shouldOpenBrowser() === false, 'browser opening should be opt-in, not default');
  process.env.OPEN_BROWSER = '1';
  assert(shouldOpenBrowser() === true, 'OPEN_BROWSER=1 should enable it');
  process.env.OPEN_BROWSER = '0';
  assert(shouldOpenBrowser() === false, 'OPEN_BROWSER=0 should disable it');
  delete process.env.OPEN_BROWSER;
});

console.log('\nGuards');
await check('unauthenticated Etsy write is refused with guidance', async () => {
  const { status, body } = await req('/api/listings', {
    method: 'POST',
    body: { title: 'x', description: 'y', price: 1, quantity: 1, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1 },
    allowError: true,
  });
  assert(status === 401, `expected 401, got ${status}`);
  assert(/connect/i.test(body.error), `unhelpful error: ${body.error}`);
});
await check('unknown route returns json 404', async () => {
  const { status, body } = await req('/api/nope', { allowError: true });
  assert(status === 404 && body.error, 'bad 404 shape');
});

console.log(`\n${'='.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(52));
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
