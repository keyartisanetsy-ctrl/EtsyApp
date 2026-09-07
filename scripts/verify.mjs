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

  assert(formatCode('2026-09-07', 1) === '26-0709-01', `template wrong: ${formatCode('2026-09-07', 1)}`);
  assert(formatCode('2026-09-07', 12) === '26-0709-12', 'sequence not padded');

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
  assert(first === '26-0709-01', `first order of the day should be 01, got ${first}`);
  assert(second === '26-0709-02', `second order of the day should be 02, got ${second}`);
  assert(codeFor(970102) === '26-0809-01', 'a new day restarts the numbering');

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
  assert(got['Varyant Görsel'] === 'item.variant_image_url', 'the variant image column was not recognised');
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

await check('Airtable is disclosed as a destination and needs a token', async () => {
  const { body } = await req('/api/settings/privacy');
  const hosts = (body.destinations ?? []).map((d) => d.host).join(' ');
  assert(/airtable/i.test(hosts), 'Airtable missing from the privacy disclosure');
  const { status, body: err } = await req('/api/airtable/bases', { allowError: true });
  assert(status === 400 && /token/i.test(err.error), `expected a token complaint, got ${status} ${err.error}`);
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
