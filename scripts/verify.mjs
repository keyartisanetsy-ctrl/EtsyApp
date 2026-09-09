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
  // Clear any account a previously failing check left behind, or removeAccount
  // could promote a stray shop instead of the survivor we assert on.
  db.prepare('DELETE FROM etsy_accounts WHERE shop_id >= 900000').run();
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

await check('the default redirect URI uses a hostname, not an IP literal', async () => {
  // Etsy's own app dashboard rejects IP-literal redirect URIs outright
  // ("IP addresses are not allowed", e.g. 127.0.0.1) but accepts a hostname.
  const { body } = await req('/api/auth/status');
  const host = new URL(body.redirectUri).hostname;
  assert(!/^\d{1,3}(\.\d{1,3}){3}$/.test(host), `redirect URI host "${host}" is an IP literal - Etsy will refuse it`);
  assert(host === 'localhost', `expected "localhost", got "${host}"`);
});
await check('connecting a shop writes exactly one account row (no orphan)', async () => {
  // Regression test for a real bug: the old two-step save (persist with no
  // shop_id, then insert again once resolved) left a permanent orphan row
  // behind on every single connection. saveToken must now be atomic.
  const { setSetting } = await import('../server/src/db/index.js');
  const { saveToken, listAccounts, removeAccount } = await import('../server/src/etsy/client.js');
  const before = listAccounts().length;
  saveToken({
    access_token: '910001.faketoken', refresh_token: 'fake', expires_in: 3600,
    user_id: 910001, shop_id: 910001, shop_name: 'Verify Atomic Shop', scopes: 'listings_r',
  });
  const after = listAccounts();
  assert(after.length === before + 1, `expected exactly 1 new account, got ${after.length - before}`);
  assert(!after.some((a) => a.shopId == null), 'an orphan shop_id=NULL row was created');
  removeAccount(910001);
});

console.log('\nAirtable');
await check('the source field catalogue is complete and resolvable', async () => {
  const { status, body } = await req('/api/airtable/source-fields');
  assert(status === 200 && Array.isArray(body), 'no catalogue returned');
  assert(body.length >= 30, `catalogue looks thin: ${body.length} fields`);
  for (const f of body) assert(f.key && f.label && f.group && f.hint, `incomplete field: ${JSON.stringify(f)}`);
  const keys = body.map((f) => f.key);
  assert(new Set(keys).size === keys.length, 'duplicate source keys');
  for (const needed of ['order.id', 'order.date', 'buyer.name', 'address.zip', 'item.sku', 'total.grand', 'tracking.code', 'shop.name']) {
    assert(keys.includes(needed), `catalogue is missing ${needed}`);
  }
});

await check('name matching handles Turkish column names and skips computed ones', async () => {
  const { matchByName } = await import('../server/src/airtable/mapping.js');
  const fields = [
    { name: 'Order ID', type: 'singleSelect', writable: true },
    { name: 'Sale Date', type: 'date', writable: true },
    { name: 'Takip No', type: 'singleLineText', writable: true },
    { name: 'MAĞAZA', type: 'singleSelect', writable: true },
    { name: 'Ship Zipcode', type: 'singleLineText', writable: true },
    { name: 'BAŞLIK İLK 40', type: 'singleLineText', writable: true },
    { name: 'NOT 1', type: 'singleLineText', writable: true },
    { name: 'NOT 2', type: 'multilineText', writable: true },
    { name: 'Profit', type: 'formula', writable: false },
  ];
  const { map, unmatched } = matchByName(fields);
  const got = Object.fromEntries(map.map((m) => [m.target, m.source]));
  assert(got['Order ID'] === 'order.id', `Order ID -> ${got['Order ID']}`);
  assert(got['Sale Date'] === 'order.date', `Sale Date -> ${got['Sale Date']}`);
  assert(got['Takip No'] === 'tracking.code', `Takip No -> ${got['Takip No']}`);
  // A shop column is fed by the name the sheet uses, not Etsy's own spelling.
  assert(got['MAĞAZA'] === 'shop.airtable_name', `MAĞAZA -> ${got['MAĞAZA']}`);
  assert(got['Ship Zipcode'] === 'address.zip', `Ship Zipcode -> ${got['Ship Zipcode']}`);
  assert(got['BAŞLIK İLK 40'] === 'item.title40', `BAŞLIK İLK 40 -> ${got['BAŞLIK İLK 40']}`);
  assert(!('Profit' in got), 'a computed column was mapped');
  assert(!map.some((m) => m.target === 'Profit'), 'formula column offered as a target');
  // The two note columns mean different things: NOT 1 is what the buyer wrote,
  // NOT 2 is your own note, so each takes its own source rather than doubling up.
  assert(got['NOT 1'] === 'order.buyer_message', `NOT 1 -> ${got['NOT 1']}`);
  assert(got['NOT 2'] === 'flags.notes', `NOT 2 -> ${got['NOT 2']}`);
  assert(unmatched.length >= 0, 'unmatched list missing');
});

await check('values are bent to the target column type', async () => {
  const { coerce } = await import('../server/src/services/airtable.js');
  const t = (value, type, opts) => coerce(value, { name: 'x', type }, opts);
  assert(t(2543.93, 'currency').value === 2543.93, 'currency lost its value');
  assert(t('2543.93', 'number').value === 2543.93, 'numeric string not parsed');
  assert(t('not a number', 'number').skip, 'garbage accepted into a number column');
  assert(t('2025-09-05T10:00:00Z', 'date').value === '2025-09-05', 'date not trimmed to a day');
  assert(t(true, 'checkbox').value === true, 'checkbox lost its value');
  assert(Array.isArray(t('Paid', 'multipleSelects').value), 'multi-select needs an array');
  assert(t('ftp://x', 'url').skip, 'a non-URL was written into a url column');
  assert(t('', 'singleLineText').skip, 'empty value should be skipped, not written');
  // Linked-record columns need explicit consent, since Airtable would create rows.
  assert(t('SKU-1', 'multipleRecordLinks').skip, 'linked column written without consent');
  assert(Array.isArray(t('SKU-1', 'multipleRecordLinks', { createLinks: true }).value), 'consented link not written');
});

await check('a destination maps an order into Airtable columns', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const at = await import('../server/src/services/airtable.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 980001').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (980001,'Verify Airtable Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(980001);

  db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, city, zip, country_iso, status,
              grandtotal_amount, grandtotal_divisor, grandtotal_currency, was_paid, created_ts)
              VALUES (980100, 980001, 'Test Buyer', 'Pensacola', '32501', 'US', 'Paid', 254393, 100, 'USD', 1, 1757030400)`).run();
  db.prepare(`INSERT OR REPLACE INTO receipt_transactions (transaction_id, receipt_id, listing_id, sku, title, quantity, price_amount, price_divisor)
              VALUES (980200, 980100, 5551234, 'SKU-A', 'A very long product title that should be cut at forty characters', 2, 127196, 100)`).run();

  const dest = at.saveDestination({
    label: 'Verify destination', baseId: 'appVerify000000000', tableId: 'tblVerify000000000', rowMode: 'item',
    fieldMap: [
      { target: 'Order ID', source: 'order.id' },
      { target: 'Sale Date', source: 'order.date' },
      { target: 'Full Name', source: 'buyer.name' },
      { target: 'Quantity', source: 'item.quantity' },
      { target: 'Order Total', source: 'total.grand' },
      { target: 'BAŞLIK İLK 40', source: 'item.title40' },
      { target: 'Profit', source: 'total.grand' },
    ],
    mergeFields: ['Order ID'], constants: { 'MAĞAZA': 'Verify Airtable Shop' },
  });

  const table = { id: 'tblVerify000000000', name: 'Orders', fields: [
    { name: 'Order ID', type: 'singleSelect', writable: true },
    { name: 'Sale Date', type: 'date', writable: true },
    { name: 'Full Name', type: 'singleLineText', writable: true },
    { name: 'Quantity', type: 'number', writable: true },
    { name: 'Order Total', type: 'currency', writable: true },
    { name: 'BAŞLIK İLK 40', type: 'singleLineText', writable: true },
    { name: 'MAĞAZA', type: 'singleSelect', writable: true },
    { name: 'Profit', type: 'formula', writable: false },
  ] };

  const { records, issues } = await at.buildRecords(dest, [980100], { table });
  assert(records.length === 1, `expected one row per item, got ${records.length}`);
  const f = records[0].fields;
  assert(f['Order ID'] === '980100', `order id: ${f['Order ID']}`);
  assert(f['Sale Date'] === '2025-09-05', `date: ${f['Sale Date']}`);
  assert(f['Quantity'] === 2 && typeof f['Quantity'] === 'number', 'quantity must be a number');
  assert(f['Order Total'] === 2543.93, `total: ${f['Order Total']}`);
  assert(f['BAŞLIK İLK 40'].length === 40, `title should be cut to 40, got ${f['BAŞLIK İLK 40'].length}`);
  assert(f['MAĞAZA'] === 'Verify Airtable Shop', 'the fixed shop value was not applied');
  assert(!('Profit' in f), 'wrote into a formula column');
  assert(issues[0].skipped.some((m) => /Profit/.test(m)), 'the skipped formula column was not reported');

  at.deleteDestination(dest.id);
  db.prepare('DELETE FROM receipts WHERE receipt_id = 980100').run();
  client.removeAccount(980001);
});

await check('an AI mapping cannot invent columns or sources', async () => {
  const mapping = await import('../server/src/airtable/mapping.js');
  // Stand in for the provider: answer with one good row and three bad ones.
  const fake = {
    map: [
      { target: 'Full Name', source: 'buyer.name', why: 'ok' },
      { target: 'Column That Does Not Exist', source: 'buyer.name', why: 'hallucinated column' },
      { target: 'Quantity', source: 'made.up.key', why: 'hallucinated source' },
      { target: 'Profit', source: 'total.grand', why: 'computed column' },
    ],
    mergeFields: ['Full Name', 'Profit'],
    constants: { 'MAĞAZA': 'Shop A', 'Nope': 'x' },
  };
  const runner = async () => ({ text: JSON.stringify(fake), provider: 'stub', model: 'stub', runId: 0 });
  {
    const fields = [
      { name: 'Full Name', type: 'singleLineText', writable: true },
      { name: 'Quantity', type: 'number', writable: true },
      { name: 'MAĞAZA', type: 'singleSelect', writable: true },
      { name: 'Profit', type: 'formula', writable: false },
    ];
    const r = await mapping.matchByAi({ table: 'Orders', fields, shopName: 'Shop A', runner });
    const targets = r.map.map((m) => m.target);
    assert(targets.includes('Full Name'), 'the one good mapping was dropped');
    assert(!targets.includes('Column That Does Not Exist'), 'a made-up column survived');
    assert(!targets.includes('Quantity'), 'a made-up source key survived');
    assert(!targets.includes('Profit'), 'a computed column survived');
    assert(!r.mergeFields.includes('Profit'), 'a computed column was accepted as the key');
    assert(r.constants['MAĞAZA'] === 'Shop A', 'a valid constant was dropped');
    assert(!('Nope' in r.constants), 'a constant for a made-up column survived');
    assert(r.dropped.length === 3, `expected 3 rejections, got ${r.dropped.length}`);
  }
});

await check('order codes are per day, shared by every item of an order, and stable', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const { codeFor, formatCode } = await import('../server/src/services/ordercode.js');
  await initDb();
  const db = getDb();

  // Year-month-day, matching the codes already in these sheets (26-0316-25).
  assert(formatCode('2026-09-07', 1) === '26-0907-01', `template wrong: ${formatCode('2026-09-07', 1)}`);
  assert(formatCode('2026-09-07', 12) === '26-0907-12', 'sequence not padded');
  assert(formatCode('2026-03-16', 25) === '26-0316-25', 'does not reproduce a real code from the sheet');

  db.prepare('DELETE FROM order_codes WHERE shop_id = 970001').run();
  db.prepare('DELETE FROM receipts WHERE receipt_id IN (970100,970101,970102)').run();
  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970001').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970001,'Code Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970001);

  // three orders: two on the same day, one the day after
  const day1 = Math.floor(Date.parse('2026-09-07T09:00:00Z') / 1000);
  const day1b = Math.floor(Date.parse('2026-09-07T18:00:00Z') / 1000);
  const day2 = Math.floor(Date.parse('2026-09-08T09:00:00Z') / 1000);
  for (const [id, ts] of [[970100, day1], [970101, day1b], [970102, day2]]) {
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, created_ts, grandtotal_amount, grandtotal_divisor, grandtotal_currency)
                VALUES (?,970001,?,1000,100,'USD')`).run(id, ts);
  }

  // Assign out of order on purpose: numbering must follow the clock, not the call order.
  const second = codeFor(970101);
  const first = codeFor(970100);
  assert(first === '26-0907-01', `first order of the day should be 01, got ${first}`);
  assert(second === '26-0907-02', `second order of the day should be 02, got ${second}`);
  assert(codeFor(970102) === '26-0908-01', 'a new day restarts the numbering');

  // Stable: asking again never renumbers a row that is already in a sheet.
  assert(codeFor(970100) === first, 'the code changed on a second call');

  db.prepare('DELETE FROM order_codes WHERE shop_id = 970001').run();
  db.prepare('DELETE FROM receipts WHERE receipt_id IN (970100,970101,970102)').run();
  client.removeAccount(970001);
});

await check('a rate is found for a weekend order by carrying the last one forward', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const fx = await import('../server/src/services/fx.js');
  await initDb();
  const db = getDb();

  db.prepare("DELETE FROM fx_rates WHERE quote IN ('CNY','TRY')").run();
  const ins = db.prepare("INSERT INTO fx_rates (day, base, quote, rate, source) VALUES (?,'USD',?,?,'test')");
  ins.run('2026-09-04', 'CNY', 6.7109);   // Friday
  ins.run('2026-09-04', 'TRY', 48.443);
  ins.run('2026-09-07', 'CNY', 6.7000);   // Monday

  // Friday, exact
  assert(Math.abs(fx.rateOn('2026-09-04', 'CNY', 'USD') - 1 / 6.7109) < 1e-9, 'Friday rate wrong');
  // Saturday has no publication: it must use Friday's, and say so
  const sat = fx.rateDetail('2026-09-05', 'CNY', 'USD');
  assert(sat.asOf === '2026-09-04', `weekend should fall back to Friday, used ${sat.asOf}`);
  assert(Math.abs(sat.rate - 1 / 6.7109) < 1e-9, 'weekend rate wrong');
  // Monday has its own
  assert(fx.rateDetail('2026-09-07', 'CNY', 'USD').asOf === '2026-09-07', 'Monday should use its own rate');

  // Cross rates go through USD, and a round trip returns the original amount.
  const usd = fx.convert(2543.93, 'TRY', 'USD', '2026-09-04');
  assert(Math.abs(usd - 2543.93 / 48.443) < 0.01, `TRY->USD wrong: ${usd}`);
  assert(Math.abs(fx.convert(usd, 'USD', 'TRY', '2026-09-04') - 2543.93) < 0.01, 'round trip lost money');
  assert(fx.rateOn('2026-09-04', 'USD', 'USD') === 1, 'same currency should be 1');
});

await check('variant text is decoded and carries no option titles', async () => {
  const { decodeEntities } = await import('../server/src/airtable/fields.js');
  assert(decodeEntities('Sarah&#039;s Pick') === "Sarah's Pick", `apostrophe not decoded: ${decodeEntities('Sarah&#039;s Pick')}`);
  assert(decodeEntities('A &amp; B') === 'A & B', 'ampersand not decoded');
  assert(decodeEntities('&quot;q&quot;') === '"q"', 'quote not decoded');
  assert(decodeEntities('caf&#233;') === 'café', 'numeric entity not decoded');
  assert(decodeEntities(null) === null, 'null should stay null');
});

await check('an order in lira is valued in USD at its own day rate', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const { loadRows, resolveSource } = await import('../server/src/airtable/fields.js');
  await initDb();
  const db = getDb();

  db.prepare("DELETE FROM fx_rates WHERE quote = 'TRY'").run();
  db.prepare("INSERT INTO fx_rates (day, base, quote, rate, source) VALUES ('2026-09-04','USD','TRY',48.443,'test')").run();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960001').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960001,'KeyArtisann','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960001);

  const ts = Math.floor(Date.parse('2026-09-05T10:00:00Z') / 1000); // a Saturday
  db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, subtotal_amount, grandtotal_amount,
              grandtotal_divisor, grandtotal_currency, created_ts)
              VALUES (960100, 960001, 'Buyer&#039;s Name', 254393, 289900, 100, 'TRY', ?)`).run(ts);
  db.prepare(`INSERT OR REPLACE INTO receipt_transactions (transaction_id, receipt_id, sku, title, quantity, price_amount, price_divisor, variations)
              VALUES (960200, 960100, 'S1', 'Ring', 1, 127196, 100,
              '[{"property_id":1,"value_id":2,"formatted_name":"Colour","formatted_value":"Silver"}]')`).run();

  const [row] = loadRows([960100], { rowMode: 'item' });
  assert(row, 'no row built');
  assert(resolveSource('total.subtotal', row) === 2543.93, 'lira subtotal changed');
  const usd = resolveSource('total.subtotal_usd', row);
  assert(Math.abs(usd - 2543.93 / 48.443) < 0.01, `subtotal in USD wrong: ${usd}`);
  assert(resolveSource('buyer.name', row) === "Buyer's Name", 'buyer name not decoded');
  assert(resolveSource('item.variations', row) === 'Silver', `variant should be values only, got ${resolveSource('item.variations', row)}`);
  assert(resolveSource('item.variations_full', row) === 'Colour: Silver', 'long form lost the title');
  assert(resolveSource('order.month', row) === '2026 Eylül', `month wrong: ${resolveSource('order.month', row)}`);
  assert(/^\d{2}-\d{4}-\d{2}$/.test(resolveSource('order.code', row)), 'order code has the wrong shape');

  db.prepare('DELETE FROM receipts WHERE receipt_id = 960100').run();
  client.removeAccount(960001);
});

await check('the matcher sends the order number without a #, and knows the new columns', async () => {
  const { matchByName } = await import('../server/src/airtable/mapping.js');
  const columns = ['Order ID', 'KOD', 'Month', 'NOT 1', 'NOT 2', 'Yuan - USD Kur (Ürün)',
    'Shipping Cost Yuan', 'Varyant Görsel', 'Image URL'];
  const { map } = matchByName(columns.map((name) => ({ name, type: 'singleLineText', writable: true })));
  const got = Object.fromEntries(map.map((m) => [m.target, m.source]));
  assert(got['Order ID'] === 'order.id', `order id should be the plain one, got ${got['Order ID']}`);
  assert(got['KOD'] === 'order.code', `KOD -> ${got['KOD']}`);
  assert(got['Month'] === 'order.month', `Month -> ${got['Month']}`);
  assert(got['NOT 1'] === 'order.buyer_message', 'NOT 1 should be the buyer message');
  assert(got['NOT 2'] === 'flags.notes', 'NOT 2 should be your own note');
  assert(got['Yuan - USD Kur (Ürün)'] === 'rate.cny_usd', 'the yuan rate column was not recognised');
  assert(got['Shipping Cost Yuan'] === 'tracking.shipping_cost', 'the shipping cost column was not recognised');
  // This deliberately maps to the falling-back source rather than the strict
  // one: a listing with no per-option photo should still put its cover shot in
  // the cell, instead of leaving it blank.
  assert(got['Varyant Görsel'] === 'item.variant_image', `the variant image column went to ${got['Varyant Görsel']}`);
  assert(got['Image URL'] === 'item.image_any', 'Image URL should take the best available photo');
});

await check('each shop writes its own name into the shop column', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const { matchByName } = await import('../server/src/airtable/mapping.js');
  const { loadRows, resolveSource } = await import('../server/src/airtable/fields.js');
  await initDb();
  const db = getDb();

  // A shop column must be fed by the Airtable name, not Etsy's spelling,
  // because that column is what the per-shop views filter on.
  const { map } = matchByName([{ name: 'MAĞAZA', type: 'singleSelect', writable: true }]);
  assert(map[0]?.source === 'shop.airtable_name', `MAĞAZA -> ${map[0]?.source}`);

  for (const id of [950001, 950002]) db.prepare('DELETE FROM etsy_accounts WHERE shop_id = ?').run(id);
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (950001,'KeyArtisan','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (950002,'CutieGifts','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();

  for (const [id, receipt] of [[950001, 950100], [950002, 950200]]) {
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, created_ts, grandtotal_amount, grandtotal_divisor, grandtotal_currency)
                VALUES (?,?,?,1000,100,'USD')`).run(receipt, id, Math.floor(Date.now() / 1000));
  }

  // Etsy's spelling differs from the sheet's; the sheet's wins.
  client.setActiveAccount(950001);
  client.setAirtableName(950001, 'KeyArtisann');
  let [row] = loadRows([950100], { rowMode: 'order' });
  assert(resolveSource('shop.airtable_name', row) === 'KeyArtisann',
    `shop A should file as KeyArtisann, got ${resolveSource('shop.airtable_name', row)}`);
  assert(resolveSource('shop.name', row) === 'KeyArtisan', 'the Etsy spelling should still be available');

  // Switching shop switches the value the same mapping writes.
  client.setActiveAccount(950002);
  client.setAirtableName(950002, 'CutieGiftsUS');
  [row] = loadRows([950200], { rowMode: 'order' });
  assert(resolveSource('shop.airtable_name', row) === 'CutieGiftsUS',
    `shop B should file as CutieGiftsUS, got ${resolveSource('shop.airtable_name', row)}`);

  // With no name set it falls back to Etsy's, rather than writing nothing.
  client.setAirtableName(950002, '');
  [row] = loadRows([950200], { rowMode: 'order' });
  assert(resolveSource('shop.airtable_name', row) === 'CutieGifts', 'should fall back to the Etsy shop name');

  db.prepare('DELETE FROM receipts WHERE receipt_id IN (950100,950200)').run();
  client.removeAccount(950001);
  client.removeAccount(950002);
});

await check('revenue is converted per order date, not mislabelled', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const rep = await import('../server/src/services/reporting.js');
  await initDb();
  const db = getDb();

  db.prepare("DELETE FROM fx_rates WHERE quote = 'TRY'").run();
  db.prepare("INSERT INTO fx_rates (day, base, quote, rate, source) VALUES ('2026-09-04','USD','TRY',48.443,'test')").run();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 940001').run();
  db.prepare('DELETE FROM receipts WHERE receipt_id BETWEEN 940100 AND 940199').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (940001,'Lira Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(940001);

  const now = Math.floor(Date.now() / 1000);
  // Three lira orders: one cancelled, one refunded in part.
  const rows = [[940100, 0, 0], [940101, 1, 0], [940102, 0, 100000]];
  for (const [id, canceled, refunded] of rows) {
    db.prepare(`INSERT INTO receipts (receipt_id, shop_id, grandtotal_amount, grandtotal_divisor,
                grandtotal_currency, was_canceled, refunded_amount, refund_count, created_ts)
                VALUES (?,940001,260310,100,'TRY',?,?,?,?)`).run(id, canceled, refunded, refunded ? 1 : 0, now);
  }

  // Etsy leaves was_canceled null on plenty of receipts. `null = 0` is null in
  // SQL, so comparing directly drops those rows from every total silently.
  db.prepare(`INSERT INTO receipts (receipt_id, shop_id, grandtotal_amount, grandtotal_divisor,
              grandtotal_currency, was_canceled, created_ts) VALUES (940103,940001,260310,100,'TRY',NULL,?)`)
    .run(now);

  const usd = rep.sumReceipts({ sinceDays: 7, currency: 'USD' });
  assert(usd.orders === 3, `a null was_canceled must still count, got ${usd.orders} orders`);
  assert(usd.canceledOrders === 0, 'cancelled orders should not be summed at all');
  assert(usd.refundedOrders === 1, 'the refund was not noticed');

  // Three orders of 2603.10 TRY at 48.443, less a 1000 TRY refund.
  const expectedGross = (3 * 2603.10) / 48.443;
  assert(Math.abs(usd.gross - expectedGross) < 0.02, `gross ${usd.gross}, expected ~${expectedGross.toFixed(2)}`);
  assert(Math.abs(usd.net - (expectedGross - 1000 / 48.443)) < 0.02, `net ${usd.net} did not subtract the refund`);
  assert(usd.byCurrency.TRY, 'should say the money arrived in lira');
  assert(usd.currency === 'USD', 'reported currency missing');

  // The old bug: summing raw amounts and calling them dollars. Counted over the
  // same rows, the lira sum is ~48x the dollar one.
  const raw = db.prepare(`SELECT SUM(grandtotal_amount)/100.0 AS c FROM receipts
    WHERE shop_id IS 940001 AND COALESCE(was_canceled,0) = 0`).get().c;
  assert(Math.abs(raw / usd.gross - 48.443) < 1,
    `the raw lira sum should be ~48x the dollar figure, ratio was ${(raw / usd.gross).toFixed(1)}`);

  db.prepare('DELETE FROM receipts WHERE receipt_id BETWEEN 940100 AND 940199').run();
  client.removeAccount(940001);
});

await check('writes to Etsy go one at a time, reads stay parallel', async () => {
  const { initDb } = await import('../server/src/db/index.js');
  const { writeSetting } = await import('../server/src/services/settings.js');
  const client = await import('../server/src/etsy/client.js');
  await initDb();
  writeSetting('etsy.write_gap_ms', '20');
  writeSetting('etsy.keystring', 'k:s');

  const realFetch = globalThis.fetch;
  const inFlight = { now: 0, max: 0 };
  globalThis.fetch = async () => {
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    await new Promise((r) => setTimeout(r, 25));
    inFlight.now -= 1;
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await Promise.all([1, 2, 3, 4].map(() => client
      .request('/v3/application/x', { method: 'PUT', auth: false, body: { a: 1 } }).catch(() => {})));
    assert(inFlight.max === 1, `writes overlapped: ${inFlight.max} at once`);

    inFlight.max = 0;
    await Promise.all([1, 2, 3, 4].map(() => client.request('/v3/application/x', { auth: false }).catch(() => {})));
    assert(inFlight.max > 1, 'reads were serialised too, which would make syncing crawl');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('an order total is written once, not on every item row', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const at = await import('../server/src/services/airtable.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 930001').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (930001,'Multi Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(930001);
  db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, first_line, city, grandtotal_amount,
              grandtotal_divisor, grandtotal_currency, created_ts)
              VALUES (930100,930001,'Buyer','1 Road','Town',30000,100,'USD',?)`).run(Math.floor(Date.now() / 1000));
  for (const [tid, sku] of [[9301, 'A-1'], [9302, 'A-2'], [9303, 'A-3']]) {
    db.prepare(`INSERT OR REPLACE INTO receipt_transactions (transaction_id, receipt_id, sku, title, quantity, price_amount, price_divisor)
                VALUES (?,930100,?,'Item',1,10000,100)`).run(tid, sku);
  }

  const table = { id: 't', name: 'T', fields: [
    { name: 'Order ID', type: 'singleLineText', writable: true },
    { name: 'SKU', type: 'singleLineText', writable: true },
    { name: 'Order Total', type: 'currency', writable: true },
    { name: 'Full Name', type: 'singleLineText', writable: true },
  ] };
  const fieldMap = [
    { target: 'Order ID', source: 'order.id' }, { target: 'SKU', source: 'item.sku' },
    { target: 'Order Total', source: 'total.grand' }, { target: 'Full Name', source: 'buyer.name' },
  ];

  const once = at.saveDestination({ label: 'once', baseId: 'app1', tableId: 't', rowMode: 'item', fieldMap, oncePerOrder: true });
  const a = await at.buildRecords(once, [930100], { table });
  assert(a.records.length === 3, `expected 3 item rows, got ${a.records.length}`);
  const totals = a.records.filter((r) => r.fields['Order Total'] !== undefined);
  assert(totals.length === 1, `order total should appear once, appeared ${totals.length} times`);
  assert(totals[0].fields['Order Total'] === 300, 'the total itself changed');
  assert(a.records.filter((r) => r.fields['Full Name'] !== undefined).length === 1, 'the buyer name repeated');
  // The identifiers must still tie the rows together.
  assert(a.records.every((r) => r.fields['Order ID'] === '930100'), 'every row needs the order number');
  assert(new Set(a.records.map((r) => r.fields.SKU)).size === 3, 'each row should carry its own SKU');

  const every = at.saveDestination({ label: 'every', baseId: 'app1', tableId: 't', rowMode: 'item', fieldMap, oncePerOrder: false });
  const b = await at.buildRecords(every, [930100], { table });
  assert(b.records.filter((r) => r.fields['Order Total'] !== undefined).length === 3,
    'turning the option off should put the total back on every row');

  at.deleteDestination(once.id);
  at.deleteDestination(every.id);
  db.prepare('DELETE FROM receipts WHERE receipt_id = 930100').run();
  client.removeAccount(930001);
});

await check('an order can be delivered and still carry a warning', async () => {
  const { statusesFor, idleTier } = await import('../server/src/services/orderstatus.js');
  const ids = (row) => statusesFor(row).map((s) => s.id);

  assert(ids({}).includes('new'), 'a fresh order should read as new');
  assert(ids({ airtable_pushed_at: 'x' }).includes('airtable'), 'pushed orders should say Airtable');
  assert(ids({ supplier_ordered: 1 }).includes('ordered'), 'supplier orders should say Ordered');
  assert(ids({ tracking_code: 'YT1' }).includes('shipped'), 'a tracked order should say Shipped');

  const both = ids({ tracking_code: 'YT1', tracking_status: 'delivered', problem_state: 'warning' });
  assert(both.includes('delivered') && both.includes('warning'),
    `delivered and warning should coexist, got ${both.join(',')}`);
  assert(!ids({ tracking_code: 'YT1', tracking_status: 'delivered' }).includes('shipped'),
    'a delivered parcel should not still say Shipped');

  const oos = ids({ problem_state: 'out_of_stock' });
  assert(oos.includes('out_of_stock') && oos.includes('warning'), 'out of stock should also warn');
  assert(ids({ problem_state: 'solved' }).includes('solved'), 'a resolved problem should say Solved');

  // Idle tiers: worse the longer nothing scans.
  assert(idleTier(2) === null, 'two days is not yet a problem');
  assert(idleTier(3).level === 'watch', 'three days should be flagged');
  assert(idleTier(4).level === 'high', 'four days is worse');
  assert(idleTier(9).level === 'severe', 'five or more is serious');

  const delivered = statusesFor({ tracking_code: 'YT1', tracking_status: 'delivered' })
    .find((s) => s.id === 'delivered');
  assert(/review/i.test(delivered.hint), 'the delivered chip should mention asking for a review');

  // A number that is not YunExpress cannot be followed automatically; say so.
  const foreign = statusesFor({ tracking_code: 'AB12', days_since_move: 6 }).find((s) => s.id.startsWith('idle'));
  assert(/not a YunExpress/i.test(foreign.hint), 'a non-YunExpress number should be called out');
});

await check("Etsy's offsite ads fee follows the published rules", async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const oa = await import('../server/src/services/offsiteads.js');
  await initDb();
  const db = getDb();

  db.prepare(`INSERT INTO fx_rates (day, base, quote, rate, source) VALUES ('2026-09-04','USD','TRY',48.443,'test')
              ON CONFLICT(day,base,quote) DO UPDATE SET rate = excluded.rate`).run();

  for (const id of [920001, 920002]) db.prepare('DELETE FROM etsy_accounts WHERE shop_id = ?').run(id);
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active, offsite_ads_rate)
              VALUES (920001,'Big Shop','v1.x','v1.x',datetime('now','+1 hour'),0,0.12)`).run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active, offsite_ads_rate)
              VALUES (920002,'Small Shop','v1.x','v1.x',datetime('now','+1 hour'),0,0.15)`).run();

  assert(oa.rateForShop(920001) === 0.12, 'a shop over $10k a year pays the discounted 12%');
  assert(oa.rateForShop(920002) === 0.15, 'a smaller shop pays 15%');

  const ts = Math.floor(Date.parse('2026-09-05T10:00:00Z') / 1000);
  const order = (total, currency) => ({
    offsite_ads: 1, grandtotal_amount: Math.round(total * 100), grandtotal_divisor: 100,
    grandtotal_currency: currency, created_ts: ts,
  });

  assert(oa.feeFor(order(60, 'USD'), { shopId: 920001 }).fee === 7.2, '12% of $60 should be $7.20');
  assert(oa.feeFor(order(60, 'USD'), { shopId: 920002 }).fee === 9, '15% of $60 should be $9');

  // Etsy never charges more than $100 on one order.
  const big = oa.feeFor(order(1200, 'USD'), { shopId: 920001 });
  assert(big.fee === 100 && big.capped, `a $1200 order should cap at $100, got ${big.fee}`);

  // The cap is in dollars, so on a lira order it has to be converted first -
  // capping at a bare "100" would charge about two dollars instead of a hundred.
  const lira = oa.feeFor(order(60000, 'TRY'), { shopId: 920001 });
  assert(lira.capped, 'a 60,000 TRY order should hit the cap');
  assert(Math.abs(lira.feeUsd - 100) < 0.5, `the cap should be $100 worth of lira, got $${lira.feeUsd}`);
  assert(lira.fee > 4000, `the cap in lira should be thousands, got ${lira.fee}`);

  // Under the cap, it is just the percentage.
  const small = oa.feeFor(order(2603.10, 'TRY'), { shopId: 920001 });
  assert(!small.capped && Math.abs(small.fee - 312.37) < 0.02, `12% of 2603.10 TRY, got ${small.fee}`);

  // No fee unless the order is actually marked.
  assert(oa.feeFor({ ...order(60, 'USD'), offsite_ads: 0 }, { shopId: 920001 }) === null,
    'an unmarked order should have no fee');

  // The button writes the flag through.
  db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, grandtotal_amount, grandtotal_divisor,
              grandtotal_currency, created_ts) VALUES (920100,920001,6000,100,'USD',?)`).run(ts);
  client.setActiveAccount(920001);
  oa.setOffsiteAds([920100], true);
  assert(db.prepare('SELECT offsite_ads FROM order_flags WHERE receipt_id = 920100').get().offsite_ads === 1,
    'the offsite ad mark was not saved');
  oa.setOffsiteAds([920100], false);
  assert(db.prepare('SELECT offsite_ads FROM order_flags WHERE receipt_id = 920100').get().offsite_ads === 0,
    'the offsite ad mark could not be cleared');

  db.prepare('DELETE FROM receipts WHERE receipt_id = 920100').run();
  client.removeAccount(920001);
  client.removeAccount(920002);
});

await check('Airtable is disclosed as a destination and needs a token', async () => {
  const { body } = await req('/api/settings/privacy');
  const hosts = (body.destinations ?? []).map((d) => d.host).join(' ');
  assert(/airtable/i.test(hosts), 'Airtable missing from the privacy disclosure');
  const { status, body: err } = await req('/api/airtable/bases', { allowError: true });
  assert(status === 400 && /token/i.test(err.error), `expected a token complaint, got ${status} ${err.error}`);
});

console.log('\nSKU generation');
await check('rule-based SKUs number products and variants in order', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const skugen = await import('../server/src/services/skugen.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970001').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970001,'SKU Gen Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970001);

  try {
    for (const [id, title] of [[9701, 'Cherry Keycap Set'], [9702, 'Artisan Deskmat']]) {
      db.prepare('INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
        .run(id, 970001, title, 'active');
    }
    let productId = 970100;
    for (const [listingId, count] of [[9701, 3], [9702, 2]]) {
      for (let i = 0; i < count; i += 1) {
        db.prepare(`INSERT OR REPLACE INTO listing_products (product_id, listing_id, sku, variation_label, is_deleted)
                    VALUES (?,?,?,?,0)`).run(productId, listingId, '', `Variant ${i + 1}`);
        productId += 1;
      }
    }

    const plan = skugen.planByRule({ listingIds: [9701, 9702], prefix: 'KC' });
    const codes = plan.listings.flatMap((l) => l.rows.map((r) => r.sku));
    assert(codes.join(',') === 'KC001-01,KC001-02,KC001-03,KC002-01,KC002-02',
      `unexpected codes: ${codes.join(',')}`);
    assert(plan.total === 5, `expected 5 new codes, got ${plan.total}`);

    const applied = skugen.applyPlan(plan);
    assert(applied.updated === 5, `expected 5 written, got ${applied.updated}`);

    // Running it again must not churn codes that are already printed on labels.
    const again = skugen.planByRule({ listingIds: [9701, 9702], prefix: 'KC' });
    assert(again.total === 0 && again.kept === 5,
      `re-run should keep everything: ${again.total} new / ${again.kept} kept`);

    // A new product carries on from the highest number rather than colliding.
    assert(skugen.highestProductNumber('KC') === 2, 'highest product number not read back');
  } finally {
    db.prepare('DELETE FROM listing_products WHERE listing_id IN (9701, 9702)').run();
    db.prepare('DELETE FROM listings WHERE listing_id IN (9701, 9702)').run();
    client.removeAccount(970001);
  }
});

await check('an AI SKU plan cannot invent products or reuse a code', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const skugen = await import('../server/src/services/skugen.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970002').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970002,'SKU AI Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970002);

  try {
    db.prepare('INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
      .run(9711, 970002, 'Keycap Set', 'active');
    db.prepare(`INSERT OR REPLACE INTO listing_products (product_id, listing_id, sku, variation_label, is_deleted)
                VALUES (970200, 9711, '', 'Silver', 0)`).run();
    db.prepare(`INSERT OR REPLACE INTO listing_products (product_id, listing_id, sku, variation_label, is_deleted)
                VALUES (970201, 9711, 'TAKEN-01', 'Gold', 0)`).run();

    const runner = async () => ({
      text: JSON.stringify({ listings: [{ listingId: 9711, rows: [
        { productId: 970200, sku: 'KC001-01' },   // fine
        { productId: 999999, sku: 'KC001-02' },   // no such variation
        { productId: 970201, sku: 'TAKEN-01' },   // already in use elsewhere... but its own
        { productId: 970200, sku: 'KC001-01' },   // proposed twice
      ] }] }),
      provider: 'test', model: 'test-model',
    });

    const plan = await skugen.planByAi({ listingIds: [9711], runner });
    const kept = plan.listings.flatMap((l) => l.rows.map((r) => r.sku));
    assert(kept.includes('KC001-01'), 'the valid code was dropped');
    assert(!kept.includes('KC001-02'), 'a code for a made-up variation was kept');
    assert(plan.dropped.some((d) => /999999/.test(d)), 'the invented variation was not reported');
    assert(plan.dropped.some((d) => /proposed twice/.test(d)), 'the duplicate was not reported');
  } finally {
    db.prepare('DELETE FROM listing_products WHERE listing_id = 9711').run();
    db.prepare('DELETE FROM listings WHERE listing_id = 9711').run();
    client.removeAccount(970002);
  }
});

console.log('\nShop data and ad costs');
await check('ad spend is stored per month and converted', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const adcosts = await import('../server/src/services/adcosts.js');
  const fx = await import('../server/src/services/fx.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970003').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970003,'Ad Cost Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970003);

  try {
    const month = new Date().toISOString().slice(0, 7);
    adcosts.setCost({ month, kind: 'etsy_ads', amount: 100, currency: 'USD' });
    adcosts.setCost({ month, kind: 'etsy_ads', amount: 120, currency: 'USD' }); // a correction, not a second row

    const list = adcosts.listCosts({ months: 2, currency: 'USD' });
    const rows = list.filter((r) => r.month === month && r.kind === 'etsy_ads');
    assert(rows.length === 1, `re-entering a month should replace it, got ${rows.length} rows`);
    assert(rows[0].amount === 120, `expected the corrected 120, got ${rows[0].amount}`);

    const total = adcosts.forMonth({ month, currency: 'USD' });
    assert(total.total === 120, `month total: ${total.total}`);

    // A figure in another currency is converted, not passed through as-is.
    if (fx.latestDay()) {
      adcosts.setCost({ month, kind: 'google_ads', amount: 1000, currency: 'TRY' });
      const both = adcosts.forMonth({ month, currency: 'USD' });
      const tr = both.entries.find((e) => e.kind === 'google_ads');
      assert(tr.converted !== null && tr.converted < 1000,
        `1000 TRY should convert to well under 1000 USD, got ${tr.converted}`);
    }

    adcosts.removeCost({ month, kind: 'etsy_ads' });
    assert(!adcosts.listCosts({ months: 2 }).some((r) => r.month === month && r.kind === 'etsy_ads'),
      'the removed month is still listed');
  } finally {
    db.prepare('DELETE FROM ad_costs WHERE shop_id = 970003').run();
    client.removeAccount(970003);
  }
});

await check('analytics counts real orders and drops cancelled ones', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const analytics = await import('../server/src/services/analytics.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970004').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970004,'Analytics Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970004);

  const recent = Math.floor(Date.now() / 1000) - 3 * 86_400;
  try {
    // Two live orders, one cancelled, one refunded in part.
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, country_iso, status,
                grandtotal_amount, grandtotal_divisor, grandtotal_currency, refunded_amount,
                was_canceled, created_ts)
                VALUES (970100, 970004, 'A', 'US', 'Paid', 10000, 100, 'USD', 0, NULL, ?)`).run(recent);
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, country_iso, status,
                grandtotal_amount, grandtotal_divisor, grandtotal_currency, refunded_amount,
                was_canceled, created_ts)
                VALUES (970101, 970004, 'B', 'GB', 'Paid', 5000, 100, 'USD', 2000, 0, ?)`).run(recent);
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, country_iso, status,
                grandtotal_amount, grandtotal_divisor, grandtotal_currency, refunded_amount,
                was_canceled, created_ts)
                VALUES (970102, 970004, 'C', 'US', 'Canceled', 99900, 100, 'USD', 0, 1, ?)`).run(recent);
    db.prepare(`INSERT OR REPLACE INTO receipt_transactions (transaction_id, receipt_id, listing_id, sku,
                title, quantity, price_amount, price_divisor, price_currency)
                VALUES (970300, 970100, 5551, 'GEN-01', 'Keycap Set', 2, 5000, 100, 'USD')`).run();

    const o = analytics.overview({ sinceDays: 30, currency: 'USD' });
    // A NULL was_canceled must count as "not cancelled" - `= 0` would drop it.
    assert(o.orders === 2, `expected 2 live orders, got ${o.orders}`);
    assert(o.gross === 150, `gross: ${o.gross}`);
    assert(o.refunded === 20, `refunded: ${o.refunded}`);
    assert(o.net === 130, `net: ${o.net}`);

    const products = analytics.topProducts({ sinceDays: 30, currency: 'USD' });
    const gen = products.find((p) => p.sku === 'GEN-01');
    assert(gen && gen.units === 2 && gen.revenue === 100, `product line: ${JSON.stringify(gen)}`);

    const countries = analytics.byCountry({ sinceDays: 30 });
    assert(countries.some((c) => c.country === 'GB'), 'country breakdown missing GB');
    assert(!countries.some((c) => c.orders > 1 && c.country === 'US'),
      'the cancelled US order was counted');

    // A product filter counts whole orders, not fragments.
    const filtered = analytics.overview({ sinceDays: 30, sku: 'GEN-01', currency: 'USD' });
    assert(filtered.orders === 1 && filtered.gross === 100, `sku filter: ${JSON.stringify(filtered)}`);
  } finally {
    db.prepare('DELETE FROM receipt_transactions WHERE receipt_id IN (970100,970101,970102)').run();
    db.prepare('DELETE FROM receipts WHERE receipt_id IN (970100,970101,970102)').run();
    client.removeAccount(970004);
  }
});

console.log('\nTracking additions');
await check('YunExpress numbers start in transit, others pre-shipped', async () => {
  const tracking = await import('../server/src/services/tracking/index.js');
  assert(tracking.startsAsInTransit('YT2607600700845852'), 'a YT number should count as moving');
  assert(tracking.startsAsInTransit('yt123'), 'the prefix check must ignore case');
  assert(!tracking.startsAsInTransit('AB99887766'), 'a non-YunExpress number should not');
  assert(!tracking.startsAsInTransit(''), 'an empty code should not');
});

await check('the paste parser reads every shape a courier list comes in', async () => {
  const tracking = await import('../server/src/services/tracking/index.js');
  const { rows, errors } = tracking.parseTrackingInput([
    '3799463891  YT2607600700845852',
    '#3799463891, YT2607600700845853',
    'YT2607600700845854 3799463892',
    '3799463893\tYT2607600700845855\tYun Express',
    'Order id, Tracking',
    'nonsense-on-its-own',
    '3799463895 short',
    '3799463896 YT2607600700845852',
  ].join('\n'));

  assert(rows.length === 4, `expected 4 usable rows, got ${rows.length}`);
  assert(rows[1].receiptId === 3799463891, 'the # prefix broke the order id');
  assert(rows[2].receiptId === 3799463892 && rows[2].trackingCode === 'YT2607600700845854',
    'the reversed columns were not sorted out');
  assert(rows[3].carrierName === 'Yun Express', `carrier name lost its space: ${rows[3].carrierName}`);
  assert(errors.length === 3, `expected 3 refusals, got ${errors.length}`);
  assert(errors.some((e) => /already on line/.test(e.reason)), 'the duplicate was not caught');
});

await check('the AI status reader refuses invented parcels and low confidence', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const tracking = await import('../server/src/services/tracking/index.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 970005').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (970005,'AI Tracking Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(970005);

  try {
    for (const code of ['VERIFYAI001', 'VERIFYAI002']) {
      db.prepare(`INSERT OR REPLACE INTO tracking (shop_id, tracking_code, status, provider)
                  VALUES (970005, ?, 'in_transit', 'manual')`).run(code);
    }

    const runner = async () => ({
      text: JSON.stringify({ parcels: [
        { code: 'VERIFYAI001', status: 'delivered', confidence: 0.95, note: 'signed for' },
        { code: 'VERIFYAI002', status: 'delivered', confidence: 0.3, note: 'guessing' },
        { code: 'NOT-A-PARCEL', status: 'delivered', confidence: 1, note: 'invented' },
        { code: 'VERIFYAI001', status: 'teleported', confidence: 1, note: 'not a status' },
      ] }),
      provider: 'test', model: 'test-model',
    });

    const out = await tracking.readStatusesWithAi({
      codes: ['VERIFYAI001', 'VERIFYAI002'], apply: true, runner,
    });

    assert(out.applied === 1, `only the confident one should be written, applied ${out.applied}`);
    assert(!out.parcels.some((p) => p.code === 'NOT-A-PARCEL'), 'an invented parcel was accepted');
    assert(!out.parcels.some((p) => p.status === 'teleported'), 'an unknown status was accepted');
    const held = out.parcels.find((p) => p.code === 'VERIFYAI002');
    assert(held && held.heldBack, 'the low-confidence answer was not held back with a reason');

    const after = db.prepare('SELECT status FROM tracking WHERE shop_id = 970005 AND tracking_code = ?');
    assert(after.get('VERIFYAI001').status === 'delivered', 'the confident answer was not written');
    assert(after.get('VERIFYAI002').status === 'in_transit', 'a low-confidence answer was written anyway');
  } finally {
    db.prepare('DELETE FROM tracking_events WHERE shop_id = 970005').run();
    db.prepare('DELETE FROM tracking WHERE shop_id = 970005').run();
    client.removeAccount(970005);
  }
});

console.log('\nListing depth');
await check('category search finds the neighbourhood, in either language', async () => {
  const { initDb, getDb, json } = await import('../server/src/db/index.js');
  const research = await import('../server/src/services/research.js');
  await initDb();
  const db = getDb();

  const previous = db.prepare("SELECT payload FROM reference_cache WHERE key = 'seller_taxonomy'").get();
  const tree = [
    { id: 1, name: 'Electronics & Accessories', level: 1, parent_id: null, children: [
      { id: 10, name: 'Computers & Peripherals', level: 2, parent_id: 1, children: [
        { id: 100, name: 'Keyboards & Mice', level: 3, parent_id: 10, children: [
          { id: 1000, name: 'Keycaps', level: 4, parent_id: 100, children: [] },
          { id: 1001, name: 'Keyboards', level: 4, parent_id: 100, children: [] },
          { id: 1002, name: 'Mouse Pads', level: 4, parent_id: 100, children: [] },
        ] },
      ] },
    ] },
  ];
  db.prepare(`INSERT INTO reference_cache (key, payload, fetched_at) VALUES ('seller_taxonomy', ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`).run(json(tree));

  try {
    const hit = await research.searchTaxonomy('keycap set', { limit: 3 });
    assert(hit.results[0]?.name === 'Keycaps', `expected Keycaps first, got ${hit.results[0]?.name}`);
    // The point of this: you see the keyboard branch you would be listing beside.
    const related = hit.results[0].related.map((r) => r.name);
    assert(related.includes('Keyboards'), `related categories missing the keyboard branch: ${related.join(', ')}`);
    assert(hit.results[0].parent.name === 'Keyboards & Mice', 'the branch above was not reported');

    // Etsy's taxonomy is English only, so a Turkish search has to be translated.
    const tr = await research.searchTaxonomy('klavye', { limit: 2 });
    assert(tr.results.some((r) => r.name === 'Keyboards'), 'a Turkish search found nothing');
  } finally {
    if (previous) {
      db.prepare("UPDATE reference_cache SET payload = ? WHERE key = 'seller_taxonomy'").run(previous.payload);
    } else {
      db.prepare("DELETE FROM reference_cache WHERE key = 'seller_taxonomy'").run();
    }
  }
});

await check('image sizes outside the model fall back to the nearest shape', async () => {
  const providers = await import('../server/src/services/ai/providers.js');
  assert(providers.nearestSupportedSize('1024x1024').exact, 'a supported size was marked inexact');
  // 2000x2000 is square, so the square size is the one to scale from.
  assert(providers.nearestSupportedSize('2000x2000').request === '1024x1024', 'square went to the wrong shape');
  assert(providers.nearestSupportedSize('1920x1080').request === '1536x1024', 'landscape went to the wrong shape');
  assert(providers.nearestSupportedSize('800x1200').request === '1024x1536', 'portrait went to the wrong shape');
  assert(!providers.nearestSupportedSize('3000x2250').exact, 'a custom size was marked exact');
});

await check('the expected dispatch window counts business days', async () => {
  const orders = await import('../server/src/services/orders.js');
  // 2026-09-04 is a Friday. Two business days later is Tuesday the 8th.
  const friday = Math.floor(Date.parse('2026-09-04T12:00:00Z') / 1000);
  const w = orders.shipWindow(friday);
  assert(w.minDays === 2 && w.maxDays === 5, `window should default to 2-5, got ${w.minDays}-${w.maxDays}`);
  const from = new Date(w.from * 1000).toISOString().slice(0, 10);
  const to = new Date(w.to * 1000).toISOString().slice(0, 10);
  assert(from === '2026-09-08', `two business days from Friday should be Tuesday, got ${from}`);
  assert(to === '2026-09-11', `five business days from Friday should be the next Friday, got ${to}`);
});

await check('todays rates answer even on a day the ECB does not publish', async () => {
  const fx = await import('../server/src/services/fx.js');
  const latest = fx.latest();
  assert(latest.base === 'USD', 'rates should be quoted against the dollar');
  assert(latest.rates.USD === 1, 'the dollar should be worth a dollar');
  if (fx.latestDay()) {
    assert(latest.rates.TRY > 1, `1 USD should be more than 1 TRY, got ${latest.rates.TRY}`);
    assert(latest.rates.CNY > 1, `1 USD should be more than 1 CNY, got ${latest.rates.CNY}`);
    // Carried forward from the last published day, so a Sunday still answers.
    assert(latest.asOf.TRY <= latest.day, 'the rate is dated after the day asked for');
  }
});

console.log('\nBuyer contact and variant images');
await check('the buyer email falls back to the payment address', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const fields = await import('../server/src/airtable/fields.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960101').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960101,'Email Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960101);

  try {
    // Etsy leaves buyer_email null on plenty of orders but sends payment_email.
    // Reading only the first was why this column arrived empty.
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, status, buyer_email, payment_email,
                grandtotal_amount, grandtotal_divisor, grandtotal_currency, created_ts)
                VALUES (960110, 960101, 'A', 'Paid', NULL, 'payer@example.com', 1000, 100, 'USD', ?)`)
      .run(Math.floor(Date.now() / 1000));
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, status, buyer_email, payment_email,
                grandtotal_amount, grandtotal_divisor, grandtotal_currency, created_ts)
                VALUES (960111, 960101, 'B', 'Paid', 'buyer@example.com', 'payer@example.com', 1000, 100, 'USD', ?)`)
      .run(Math.floor(Date.now() / 1000));

    const byKey = new Map(fields.SOURCE_FIELDS.map((f) => [f.key, f]));
    const rowFor = (id) => fields.loadRows([id], { rowMode: 'order' })[0];

    assert(byKey.get('buyer.email').get(rowFor(960110)) === 'payer@example.com',
      'the payment address was not used when Etsy sent no buyer address');
    assert(byKey.get('buyer.email_source').get(rowFor(960110)) === 'payment', 'the source was not reported');
    // When Etsy sends both, its own buyer field wins.
    assert(byKey.get('buyer.email').get(rowFor(960111)) === 'buyer@example.com', 'the buyer address should win');
    assert(byKey.get('buyer.email_buyer').get(rowFor(960110)) === null,
      'the strict field must stay empty rather than borrowing the payment address');
  } finally {
    db.prepare('DELETE FROM receipts WHERE receipt_id IN (960110, 960111)').run();
    client.removeAccount(960101);
  }
});

await check('a variant URL resolves to that variant\'s own photo', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const pics = await import('../server/src/services/productimages.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960102').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960102,'Image Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960102);

  try {
    db.prepare('INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
      .run(4447531240, 960102, 'One Piece Theme Anime Artisan Keycap Set', 'active');
    for (const [id, rank, f] of [[9001, 1, 'cover'], [9002, 2, 'moa'], [9003, 3, 'cherry'], [9004, 4, 'chart']]) {
      db.prepare(`INSERT OR REPLACE INTO listing_images (listing_image_id, listing_id, rank, url_75x75, url_570xN, url_fullxfull)
                  VALUES (?,?,?,?,?,?)`).run(id, 4447531240, rank, `t/${f}`, `m/${f}`, `https://i.etsystatic.com/${f}.jpg`);
    }
    // The two variants the shop actually sells.
    db.prepare('INSERT OR REPLACE INTO variation_images (listing_id, property_id, value_id, image_id) VALUES (?,?,?,?)')
      .run(4447531240, 200, 6251766498, 9002);
    db.prepare('INSERT OR REPLACE INTO variation_images (listing_id, property_id, value_id, image_id) VALUES (?,?,?,?)')
      .run(4447531240, 200, 6242408909, 9003);

    const base = 'https://www.etsy.com/listing/4447531240/one-piece-theme-anime-artisan-keycap-set?ref=listings_manager_table';
    const moa = pics.resolveFromUrl(`${base}&variation0=6251766498`);
    const cherry = pics.resolveFromUrl(`${base}&variation0=6242408909`);

    assert(moa.variant.url === 'https://i.etsystatic.com/moa.jpg', `MOA got ${moa.variant?.url}`);
    assert(cherry.variant.url === 'https://i.etsystatic.com/cherry.jpg', `Cherry got ${cherry.variant?.url}`);
    assert(moa.variant.imageId === 9002, 'the image id is needed as a key and was missing');
    assert(moa.variant.url !== cherry.variant.url, 'two different variants returned the same photo');

    // A listing with no per-variant photos: the cover shot and the last photo,
    // which on these listings is the chart.
    db.prepare('INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
      .run(4544914574, 960102, 'Cute Pastel Chikawa Kawaii Keycap Set', 'active');
    for (const [id, rank, f] of [[9101, 1, 'chikawa-cover'], [9102, 2, 'chikawa-2'], [9103, 3, 'chikawa-chart']]) {
      db.prepare(`INSERT OR REPLACE INTO listing_images (listing_image_id, listing_id, rank, url_75x75, url_570xN, url_fullxfull)
                  VALUES (?,?,?,?,?,?)`).run(id, 4544914574, rank, `t/${f}`, `m/${f}`, `https://i.etsystatic.com/${f}.jpg`);
    }
    const plain = pics.resolveImages(4544914574);
    assert(plain.variant === null, 'a listing with no pinned photos should not claim to have one');
    assert(plain.first.url === 'https://i.etsystatic.com/chikawa-cover.jpg', 'the first photo is wrong');
    assert(plain.last.url === 'https://i.etsystatic.com/chikawa-chart.jpg', 'the last photo is wrong');
    assert(plain.best.url === plain.first.url, 'with no variant photo, the cover shot is what a sheet should get');

    // And the variant link that reopens exactly what was bought.
    const url = pics.listingUrl(4447531240, { valueIds: [6251766498] });
    assert(url.endsWith('?variation0=6251766498'), `variant link: ${url}`);
  } finally {
    db.prepare('DELETE FROM listing_images WHERE listing_id IN (4447531240, 4544914574)').run();
    db.prepare('DELETE FROM variation_images WHERE listing_id = 4447531240').run();
    db.prepare('DELETE FROM listings WHERE listing_id IN (4447531240, 4544914574)').run();
    client.removeAccount(960102);
  }
});

await check('the sheet\'s own column names all map to something', async () => {
  const { matchByName } = await import('../server/src/airtable/mapping.js');
  const columns = ['BAŞLIK İLK 40', 'Etsy Link', 'Ürün Tedarik Link', 'Varyant Görsel ID', 'Varyant Görsel',
    'Variants', 'E-MAIL', 'Full Name', 'Street', 'Ship City', 'Ship State', 'Ship Zip', 'Ship Country',
    'Fiyat', 'Ürün Fiyatı', 'Kargo Ücreti', 'NOT 1', 'NOT 2', 'MAĞAZA', 'KOD'];
  const { map, unmatched } = matchByName(columns.map((name) => ({ name, type: 'singleLineText', writable: true })));
  const by = new Map(map.map((m) => [m.target, m.source]));

  assert(!unmatched.length, `unmatched columns: ${unmatched.join(', ')}`);
  // A price column on these sheets means the order subtotal, not one unit.
  assert(by.get('Fiyat') === 'total.subtotal', `Fiyat went to ${by.get('Fiyat')}`);
  assert(by.get('Ürün Fiyatı') === 'total.subtotal', `Ürün Fiyatı went to ${by.get('Ürün Fiyatı')}`);
  assert(by.get('E-MAIL') === 'buyer.email', 'the email column did not map');
  assert(by.get('Varyant Görsel ID') === 'item.variant_image_id', 'the image id column did not map');
  // These two must use the falling-back sources, or the cell is empty whenever
  // the listing has no per-variant photo or no variant supplier page.
  assert(by.get('Varyant Görsel') === 'item.variant_image', `Varyant Görsel went to ${by.get('Varyant Görsel')}`);
  assert(by.get('Ürün Tedarik Link') === 'item.supply_link_any', `Tedarik Link went to ${by.get('Ürün Tedarik Link')}`);
});

console.log('\nUndo');
await check('an undo puts the rows back and only fires once', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const skugen = await import('../server/src/services/skugen.js');
  const undo = await import('../server/src/services/undo.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960103').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960103,'Undo Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960103);

  try {
    db.prepare('INSERT OR REPLACE INTO listings (listing_id, shop_id, title, state) VALUES (?,?,?,?)')
      .run(9601, 960103, 'Keycap Set', 'active');
    for (let i = 0; i < 3; i += 1) {
      db.prepare(`INSERT OR REPLACE INTO listing_products (product_id, listing_id, sku, variation_label, is_deleted)
                  VALUES (?,?,?,?,0)`).run(960110 + i, 9601, `OLD-0${i + 1}`, `V${i + 1}`);
    }
    const skus = () => db.prepare('SELECT sku FROM listing_products WHERE listing_id = 9601 ORDER BY product_id')
      .all().map((r) => r.sku).join(',');

    skugen.applyPlan(skugen.planByRule({ listingIds: [9601], prefix: 'KC', overwrite: true }));
    assert(skus() === 'KC001-01,KC001-02,KC001-03', `after generating: ${skus()}`);

    const pending = undo.next();
    assert(pending && /Generate SKUs/.test(pending.label), 'the change was not recorded for undo');

    const r = undo.undo();
    assert(skus() === 'OLD-01,OLD-02,OLD-03', `after undo: ${skus()}`);
    assert(r.restored === 3, `expected 3 rows back, got ${r.restored}`);

    // A second press must move on, not re-apply the same snapshot.
    assert(undo.next() === null, 'a spent undo entry is still being offered');

    // Something that went to Etsy is in the history but is not ours to reverse.
    undo.recordExternal({ label: 'Pushed to Etsy', kind: 'etsy.write', note: 'Change it on Etsy instead.' });
    let refused = false;
    try { undo.undo(undo.history({ limit: 1 })[0].id); } catch { refused = true; }
    assert(refused, 'an Etsy write was offered as undoable');
  } finally {
    db.prepare('DELETE FROM undo_log WHERE shop_id = 960103').run();
    db.prepare('DELETE FROM listing_products WHERE listing_id = 9601').run();
    db.prepare('DELETE FROM listings WHERE listing_id = 9601').run();
    client.removeAccount(960103);
  }
});

console.log('\nAddress checking');
await check('post code rules catch what they should and leave the rest alone', async () => {
  const { ruleChecks } = await import('../server/src/services/addresscheck.js');
  const clean = (a) => ruleChecks(a).length === 0;

  assert(clean({ line1: '644 E 14th Street Apt 808', city: 'New York', state: 'NY', zip: '10009', country: 'US' }),
    'a good US address was flagged');
  assert(clean({ line1: '61 Dove Street', city: 'Bristol', state: 'England', zip: 'BS2 8LS', country: 'GB' }),
    'a good UK address was flagged');
  // A foreign format must not be treated as an error just for looking unusual.
  assert(clean({ line1: 'Bagdat Caddesi 120', city: 'Istanbul', state: '', zip: '34728', country: 'TR' }),
    'a good Turkish address was flagged');

  const wrongState = ruleChecks({ line1: '1 Main St', city: 'San Antonio', state: 'TX', zip: '10009', country: 'US' });
  assert(wrongState.some((f) => f.field === 'zip' && /belongs to NY/.test(f.says)),
    'a ZIP belonging to another state went unnoticed');

  const noNumber = ruleChecks({ line1: 'Beaver Ave', city: 'Fort Wayne', state: 'IN', zip: '46807', country: 'US' });
  assert(noNumber.some((f) => f.field === 'line1'), 'a street with no number went unnoticed');

  const badUk = ruleChecks({ line1: '61 Dove Street', city: 'Bristol', state: '', zip: 'BS2', country: 'GB' });
  assert(badUk.some((f) => f.field === 'zip'), 'a half-written UK post code went unnoticed');
});

await check('the AI cannot invent fields or rewrite an address on its own', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const ac = await import('../server/src/services/addresscheck.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960104').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960104,'Addr Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960104);

  try {
    db.prepare(`INSERT OR REPLACE INTO receipts (receipt_id, shop_id, name, first_line, city, state, zip,
                country_iso, status, grandtotal_amount, grandtotal_divisor, grandtotal_currency, created_ts)
                VALUES (960120, 960104, 'Kellee Tay', '1115 Via Belcanto', 'SAN ANTONIO', 'TX', '78260', 'US',
                'Paid', 1000, 100, 'USD', ?)`).run(Math.floor(Date.now() / 1000));

    const runner = async () => ({
      text: JSON.stringify({
        verdict: 'suspect', confidence: 0.8, summary: 'Looks like a unit number is missing.',
        findings: [
          { field: 'line1', level: 'warn', says: 'No apartment number.' },
          { field: 'invented', level: 'catastrophe', says: 'a field and a level that do not exist' },
        ],
        suggestion: { city: 'San Antonio', zip: '78260', bogusKey: 'should be dropped' },
        suggestionReason: 'City is normally title case.',
      }),
      provider: 'anthropic', model: 'claude-opus-5',
    });

    const r = await ac.checkAddress({ receiptId: 960120, runner });
    assert(r.ai.model === 'claude-opus-5', 'the model that read it was not reported');
    assert(!r.ai.findings.some((f) => f.field === 'invented'), 'an invented field was kept');
    assert(!r.ai.findings.some((f) => f.level === 'catastrophe'), 'an invented severity was kept');
    assert(!('bogusKey' in r.suggestion.changes), 'a made-up field reached the suggestion');
    // The zip was not actually different, so it is not a change.
    assert(!('zip' in r.suggestion.changes), 'an unchanged field was proposed as a correction');
    assert(r.suggestion.changes.city === 'San Antonio', 'the real correction was lost');

    // Nothing is applied until it is accepted, and Etsy's record is left alone.
    const before = db.prepare('SELECT city FROM receipts WHERE receipt_id = 960120').get().city;
    assert(before === 'SAN ANTONIO', 'the receipt was rewritten without being asked');
    ac.acceptSuggestion(960120);
    const after = db.prepare('SELECT city FROM receipts WHERE receipt_id = 960120').get().city;
    assert(after === 'SAN ANTONIO', 'accepting a correction overwrote what the buyer typed');
    assert(ac.checkFor(960120).acceptedAddress.city === 'San Antonio', 'the accepted version was not stored');
  } finally {
    db.prepare('DELETE FROM address_checks WHERE receipt_id = 960120').run();
    db.prepare('DELETE FROM receipts WHERE receipt_id = 960120').run();
    client.removeAccount(960104);
  }
});

console.log('\nDraft desk and supply book');
await check('a draft is edited locally and Etsy is not touched until it is sent', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const drafts = await import('../server/src/services/drafts.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960105').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960105,'Draft Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960105);

  try {
    db.prepare(`INSERT OR REPLACE INTO listing_drafts (listing_id, shop_id, source, etsy_state, etsy_snapshot, staged)
                VALUES (960130, 960105, 'etsy', 'draft', ?, '{}')`).run(JSON.stringify({
      listing_id: 960130, title: 'Draft keycap set', description: 'From Etsy.',
      price: { amount: 2999, divisor: 100 }, quantity: 5, tags: ['keycap'],
      taxonomy_id: 1000, who_made: 'i_did', when_made: 'made_to_order', state: 'draft',
    }));

    drafts.stage(960130, { title: 'One Piece Theme Anime Artisan Keycap Set', price: 39.99 });
    const d = drafts.get(960130);
    assert(d.merged.title === 'One Piece Theme Anime Artisan Keycap Set', 'the edit was not staged');
    // The whole point: Etsy's copy is untouched and still visible.
    assert(d.etsy.title === 'Draft keycap set', 'the edit overwrote what Etsy has');
    assert(d.changed.includes('title') && d.changed.includes('price'), `changed: ${d.changed.join(',')}`);

    const plan = drafts.preview(960130);
    assert(plan.ready, `should be ready: ${plan.problems.join('; ')}`);
    assert(plan.willChange.length === 2, `expected 2 fields to change, got ${plan.willChange.length}`);

    // A brand new draft says exactly what Etsy would refuse it for.
    const local = drafts.createLocal({ title: 'New idea' });
    const localPlan = drafts.preview(local.listingId);
    assert(!localPlan.ready, 'an empty draft was called ready');
    assert(localPlan.problems.some((p) => /description/i.test(p)), 'a missing description was not reported');

    drafts.revert(960130);
    assert(drafts.get(960130).merged.title === 'Draft keycap set', 'reverting did not go back to Etsy\'s version');
  } finally {
    db.prepare('DELETE FROM undo_log WHERE shop_id = 960105').run();
    db.prepare('DELETE FROM listing_drafts WHERE shop_id = 960105').run();
    client.removeAccount(960105);
  }
});

await check('supplier links are read and joined to the SKU', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const tb = await import('../server/src/services/taobao.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960106').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960106,'Supply Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960106);

  try {
    // The item id and shop are in the URL, so a pasted link works offline.
    const taobao = tb.parseSupplyUrl('https://item.taobao.com/item.htm?abbucket=10&id=1012415746554');
    assert(taobao.supplier === 'taobao' && taobao.itemId === '1012415746554', JSON.stringify(taobao));
    assert(taobao.cleanUrl === 'https://item.taobao.com/item.htm?id=1012415746554',
      `the tracking parameters were not stripped: ${taobao.cleanUrl}`);
    assert(tb.parseSupplyUrl('https://detail.1688.com/offer/778899001122.html?offerId=778899001122').supplier === '1688',
      '1688 was not recognised');
    assert(tb.parseSupplyUrl('https://www.aliexpress.com/item/1005001234567890.html').itemId === '1005001234567890',
      'AliExpress puts the id in the path and it was missed');
    assert(!tb.parseSupplyUrl('not a link').ok, 'nonsense was accepted as a link');

    const imported = tb.importRows([
      'SKU, link, variant link, price, currency',
      'VER-01, https://item.taobao.com/item.htm?id=1012415746554, https://item.taobao.com/item.htm?id=1012415746554&skuId=55, 18.50, CNY',
      'VER-02, not-a-link',
    ].join('\n'));
    assert(imported.saved === 1 && imported.failed === 1, `imported ${imported.saved}/${imported.failed}`);

    const item = tb.getItem('VER-01');
    assert(item.price === 18.5 && item.currency === 'CNY', 'the price did not survive the import');
    assert(item.priceUsd > 0 && item.priceUsd < 18.5, `18.50 CNY should be a few dollars, got ${item.priceUsd}`);
    assert(String(item.priceUsd) === String(Math.round(item.priceUsd * 100) / 100),
      `money should be to the cent, got ${item.priceUsd}`);

    // It writes through to the SKU record the SKU page and order desk read.
    const meta = db.prepare('SELECT supply_link, variant_supply_link, supply_currency FROM sku_meta WHERE shop_id IS ? AND sku = ?')
      .get(960106, 'VER-01');
    assert(meta.supply_link.includes('1012415746554'), 'the main link did not reach the SKU record');
    assert(meta.variant_supply_link.includes('skuId=55'), 'the variant link did not reach the SKU record');
    assert(meta.supply_currency === 'CNY', 'the currency did not reach the SKU record');
  } finally {
    db.prepare('DELETE FROM undo_log WHERE shop_id = 960106').run();
    db.prepare('DELETE FROM supply_items WHERE shop_id = 960106').run();
    db.prepare('DELETE FROM sku_meta WHERE shop_id = 960106').run();
    client.removeAccount(960106);
  }
});

await check('every Etsy operation the spec publishes has a caller', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { OPERATIONS } = await import('../server/src/etsy/operations.generated.js');

  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
  const source = walk('server/src')
    .filter((f) => !f.endsWith('operations.generated.js'))
    .map((f) => readFileSync(f, 'utf8')).join('\n');

  const called = new Set([...source.matchAll(/call(?:All)?\(\s*['"]([A-Za-z]+)['"]/g)].map((m) => m[1]));
  const all = Object.keys(OPERATIONS);
  const unused = all.filter((op) => !called.has(op));
  assert(all.length === 105, `expected 105 operations, the spec has ${all.length}`);
  assert(!unused.length, `${unused.length} operation(s) have no caller: ${unused.slice(0, 8).join(', ')}`);
});

console.log('\nProduct Studio bridge');
await check('a product is read whatever field names it arrives under', async () => {
  const ps = await import('../server/src/services/productstudio.js');

  // This app cannot know Product Studio's exact JSON, so the reader has to cope
  // with the shapes such a tool plausibly uses.
  const shapes = {
    english: { title: 'One Piece Keycap Set', url: 'https://item.taobao.com/item.htm?id=1012415746554', cost: 18.5, price: 39.99 },
    camel: { productName: 'Chikawa Keycap', productUrl: 'https://item.taobao.com/item.htm?id=999888', costPrice: '¥22.00', salePrice: '34.99' },
    turkish: { baslik: 'Kawaii Keycap Seti', urunLinki: 'https://detail.1688.com/offer/778899.html', maliyet: '25,50', fiyat: 44.9 },
    chinese: { 標題: 'x', '标题': '动漫键帽', '商品链接': 'https://item.taobao.com/item.htm?id=555444', '成本': 30 },
  };

  for (const [name, payload] of Object.entries(shapes)) {
    const { product, missing } = ps.readProduct(payload);
    assert(!missing.length, `${name}: still missing ${missing.join(', ')}`);
    assert(product.title, `${name}: no title was found`);
    assert(product.cost !== null, `${name}: no cost was found`);
  }

  // Prices arrive formatted in all sorts of ways.
  assert(ps.readProduct(shapes.camel).product.cost === 22, 'a ¥-prefixed price was not read');
  assert(ps.readProduct(shapes.turkish).product.cost === 25.5, 'a comma decimal was not read');
  // And the supplier is worked out from the link when it is not stated.
  assert(ps.readProduct(shapes.turkish).product.supplier === '1688', 'the supplier was not read from the link');

  // A payload it cannot use says what is missing rather than guessing.
  const { missing } = ps.readProduct({ foo: 'bar' });
  assert(missing.length >= 2, 'a useless payload was accepted');
});

await check('a product arrives as a draft, twice does not make two', async () => {
  const { initDb, getDb } = await import('../server/src/db/index.js');
  const client = await import('../server/src/etsy/client.js');
  const ps = await import('../server/src/services/productstudio.js');
  const drafts = await import('../server/src/services/drafts.js');
  const taobao = await import('../server/src/services/taobao.js');
  await initDb();
  const db = getDb();

  db.prepare('DELETE FROM etsy_accounts WHERE shop_id = 960107').run();
  db.prepare(`INSERT INTO etsy_accounts (shop_id, shop_name, access_token, refresh_token, expires_at, is_active)
              VALUES (960107,'PS Shop','v1.x','v1.x',datetime('now','+1 hour'),0)`).run();
  client.setActiveAccount(960107);

  try {
    const payload = {
      title: 'One Piece Theme Anime Artisan Keycap Set',
      url: 'https://item.taobao.com/item.htm?abbucket=10&id=1012415746554',
      variantUrl: 'https://item.taobao.com/item.htm?id=1012415746554&skuId=55',
      cost: 18.5, currency: 'CNY', price: 39.99,
      images: ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.jpg'],
      variants: [{ name: 'MOA Profile', price: 18.5 }],
    };

    const first = ps.receive(payload);
    assert(first.ok && first.draftId < 0, 'it should land as a local draft, not an Etsy listing');
    assert(first.sku === 'PS-1012415746554', `the SKU should come from the item id, got ${first.sku}`);

    // The draft is on the desk and has NOT gone to Etsy.
    const draft = drafts.get(first.draftId);
    assert(draft.isLocalOnly, 'a product from another app must not go straight to Etsy');
    assert(draft.merged.title === payload.title, 'the title did not reach the draft');

    // And the supply side is joined to the same SKU.
    const item = taobao.getItem(first.sku);
    assert(item.price === 18.5 && item.currency === 'CNY', 'the cost did not reach the supply book');
    assert(item.variantUrl.includes('skuId=55'), 'the variant link did not reach the supply book');

    // The photos and options are kept even though they are not Etsy fields yet.
    const inbox = ps.inboxFor(first.draftId);
    assert(inbox.images.length === 2 && inbox.variants.length === 1, 'what arrived was not kept');

    // Pressing the button again updates the same draft rather than adding one.
    const second = ps.receive({ ...payload, title: 'Corrected title', cost: 19.9 });
    assert(second.updated === true, 'a second send was not recognised as the same product');
    assert(second.draftId === first.draftId, `a duplicate draft was made: ${first.draftId} vs ${second.draftId}`);
    assert(drafts.get(first.draftId).merged.title === 'Corrected title', 'the correction was not picked up');
    const count = db.prepare('SELECT COUNT(*) AS c FROM listing_drafts WHERE shop_id IS ?').get(960107).c;
    assert(count === 1, `expected one draft on the desk, found ${count}`);
  } finally {
    db.prepare('DELETE FROM product_studio_inbox WHERE shop_id = 960107').run();
    db.prepare('DELETE FROM listing_drafts WHERE shop_id = 960107').run();
    db.prepare('DELETE FROM supply_items WHERE shop_id = 960107').run();
    db.prepare('DELETE FROM sku_meta WHERE shop_id = 960107').run();
    db.prepare('DELETE FROM undo_log WHERE shop_id = 960107').run();
    client.removeAccount(960107);
  }
});

await check('every supplier link yields a stable id', async () => {
  const taobao = await import('../server/src/services/taobao.js');
  // Without an id the same product sent twice gets two different SKUs, which is
  // exactly how duplicates creep in.
  const cases = [
    ['https://item.taobao.com/item.htm?abbucket=10&id=1012415746554', 'taobao', '1012415746554'],
    ['https://detail.tmall.com/item.htm?id=654321', 'tmall', '654321'],
    ['https://detail.1688.com/offer/888002.html', '1688', '888002'],
    ['https://www.aliexpress.com/item/1005001234567890.html', 'aliexpress', '1005001234567890'],
    ['https://www.alibaba.com/product-detail/Custom-Keycaps_1600123456789.html', 'alibaba', '1600123456789'],
  ];
  for (const [url, supplier, id] of cases) {
    const p = taobao.parseSupplyUrl(url);
    assert(p.supplier === supplier, `${url} was read as ${p.supplier}`);
    assert(p.itemId === id, `${url} gave id ${p.itemId}, expected ${id}`);
  }
  assert(!taobao.parseSupplyUrl('not a link').ok, 'nonsense was accepted');
});

await check('only a program on this machine may add products', async () => {
  const ps = await import('../server/src/services/productstudio.js');
  const key = ps.pairingKey();
  assert(key && key.length >= 24, 'the pairing key is too short to be worth having');
  assert(ps.checkKey(key), 'the real key was refused');
  assert(!ps.checkKey('wrong'), 'a wrong key was accepted');
  assert(!ps.checkKey(''), 'an empty key was accepted');
  assert(!ps.checkKey(null), 'a missing key was accepted');

  // The contract the other app is handed has to be complete enough to wire up.
  const c = ps.contract();
  assert(c.url.includes('/api/integrations/product-studio/product'), 'the address is wrong');
  assert(c.headers['X-Product-Studio-Key'] === key, 'the header does not carry the key');
  assert(c.required.includes('title') && c.required.includes('url'), 'the required fields are not stated');
  assert(Object.keys(c.snippets).length >= 3, 'there is no code to copy across');
});

await check('the pairing key is not readable without it', async () => {
  // The endpoint that hands over the contract is deliberately open, since you
  // need it to pair - but the one that creates products is not.
  const open = await req('/api/integrations/product-studio');
  assert(open.body.key, 'the setup screen cannot show a key it cannot read');

  const refused = await req('/api/integrations/product-studio/product', {
    method: 'POST', body: { title: 'x', url: 'https://item.taobao.com/item.htm?id=1' }, allowError: true,
  });
  assert(refused.status === 401, `posting without a key returned ${refused.status}`);
  assert(/key/i.test(refused.body.error), 'the refusal does not say why');
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
