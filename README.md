# Etsy Command Center

A local-first operations console for an Etsy shop, built on the **Etsy Open API v3**.
It does the work that Etsy's own seller UI makes slow: bulk edits across the
catalogue, SKU and variation management with supplier data attached, an order
desk with a tick list, bulk tracking with stale-parcel alerts, Excel exports,
AI-assisted listing writing and customer replies, and keyword research.

The API client is **generated from Etsy's official OpenAPI document**, so all
**105 operations across 27 tags** are reachable — the purpose-built screens cover
the day-to-day ones, and the built-in API explorer can invoke any of the rest.
See [`docs/etsy-api-coverage.md`](docs/etsy-api-coverage.md) for the full table.

---

## Quick start

The app runs on your own computer — nothing is hosted. Install
[Node.js 22.5 or newer](https://nodejs.org) first, then:

No build tools are needed — no Visual Studio, no Python, no compiler. The
database is the SQLite that ships inside Node itself, so there is nothing to
compile at install time.

**Windows** — double-click `START-WINDOWS.bat`
**macOS / Linux** — double-click `START-MAC-LINUX.command`

That is all. The first run installs dependencies and builds the interface
(a few minutes), then opens <http://127.0.0.1:4317> in your browser.

Prefer a terminal? One command does the same thing from a fresh clone:

```bash
npm start            # installs and builds if needed, then serves on :4317
```

**Leave that window open** while you use the app — it *is* the app. Closing it
stops the server, and the browser will then say `ERR_CONNECTION_REFUSED`.

If something is wrong, this tells you exactly what:

```bash
npm run doctor       # checks Node, dependencies, build, port, permissions
npm run fix          # installs, generates, builds, re-checks
```

For development with hot reload:

```bash
npm run dev          # API on :4317, Vite dev server on :5317
```

Want to look around before connecting a real shop:

```bash
node scripts/demo-data.mjs           # load obviously-fake sample data
node scripts/demo-data.mjs --clear   # remove it again
```

Then open **Settings**, paste your Etsy keystring, and press **Connect Etsy shop**.
Full walkthrough in [`docs/SETUP.md`](docs/SETUP.md).

---

## What it does

### SKUs and variations
One row per variation, showing everything needed to act on it: **SKU**, title,
variation, **non-discount price**, the **discounted price** (30% by default,
configurable), **supply link**, the listing's **first image** and the
**variation's own image**.

- Edit SKUs, prices and stock inline; changes stage locally and push per listing.
- Delete a SKU string, or remove the variation from the listing entirely.
- Attach private supplier data per SKU — link, supplier, unit cost, lead time,
  notes. It never leaves the machine and is never sent to Etsy, but it does show
  up next to the SKU, on the order detail, and in the Excel export.
- Margin is computed from the discounted price against the supplier cost.
- Duplicate SKUs are detected and listed, because one SKU on two variations
  quietly breaks supplier mapping.

Etsy has no per-variation patch endpoint — `PUT .../inventory` replaces the whole
product array — so every edit is a read-modify-write that rebuilds the payload
and strips the read-only fields Etsy refuses on write.

### Orders
- **Done** tick column, so a glance says what is still open, plus a separate
  **new / unseen** badge that distinguishes orders you have not looked at yet.
- Flags for flagged, and supplier-ordered, with per-order private notes.
- Detail panel with copy buttons on every block: whole order, address only,
  items only, supply links, tracking link.
- Filter by done, seen, shipped, paid, tracking presence, alerts, country, age.
- `was_paid` / `was_shipped` push back to Etsy.

### Tracking
- Bulk-add tracking by pasting `order id, tracking number, carrier` lines, or by
  uploading the pre-filled Excel template. The parser reports which lines it
  rejected and why, before anything is sent.
- Pushing to Etsy marks the order shipped and emails the buyer — or record the
  number locally only.
- Every number deep-links to `https://www.yuntrack.com/parcelTracking?id=<code>`.
  That template is a setting — `{code}` is substituted — so it can point at any
  tracker.
- Statuses: pre-shipped, on its way, out for delivery, waiting for pickup,
  delivered, exception, returned, expired, not found.
- Four lookup providers, switchable in Settings:
  **YunTrack (direct)** replays the signed query the tracking page makes for
  itself; **YunTrack (browser)** loads that page in real Chromium, which gets
  through the WAF that rejects server-side calls from some networks;
  **17TRACK** is a paid API key; **manual** turns automatic lookups off.
- **Anything that has not moved in 4+ days raises an alert** (threshold
  configurable). This is time-based, so it still fires when the carrier feed is
  unreachable. Alerts can be acknowledged, and re-arm on the next real scan.

### Listings
Every Etsy state — active, inactive, draft, expired, sold out — with activate,
deactivate, delete, and full field editing. Create listings from scratch, upload
images and video, manage digital files, personalisation, translations and
properties.

### Bulk actions
23 action types over any selection: activate, deactivate, delete, price changes
(percent / set / delta, with floors and caps), stock, tags (add / remove /
replace), find-and-replace, section, shipping profile, return policy, category,
auto-renew, SKU generation from a pattern, supply links, order flags, tracking,
and AI rewrites of titles, tags and descriptions.

Every run is a job with per-item results, **dry-run preview**, cancel, and
retry-only-the-failures.

### AI
Provider-agnostic across **Manus**, **Anthropic** and **OpenAI**, falling back to
whichever is configured and capable.

- **Customer replies** from a typed message *or an uploaded screenshot*, with the
  real order context (items, status, tracking, days idle) fed in automatically.
- **Prompt library**: a default per kind, saved prompts, and one-off manual
  prompts that can be saved back. Eight useful prompts ship with it.
- **Listing writers**: titles, descriptions, 13 tags, or a whole listing as
  structured JSON that hands off to the create screen.
- **Image studio**: edit or generate product images (OpenAI).

### Product research
Samples Etsy's live public search for a keyword and reports price bands
(min/p25/median/p75/max), tag frequency with gaps, listing age, favourites, and
favourites-per-month as a traction proxy — optionally with an AI read-out.

Etsy's API publishes no search-volume figure, so this reports what it can
actually measure rather than inventing a number.

### Excel
Real `.xlsx` via ExcelJS — frozen headers, auto-filters, typed cells, clickable
links, alert rows highlighted. Orders (three sheets: summary, line items,
tracking), SKUs, listings, tracking, and a fill-in-the-blank tracking template.

---

## Architecture

```
server/src/
  etsy/       operations.generated.js  all 105 operations, generated from the spec
              client.js                auth refresh, 10 req/s token bucket, retry, call log
              oauth.js                 OAuth2 authorization-code + PKCE
  services/   sync, inventory, listings, orders, tracking/, ai/, research, bulk, excel
  routes/     one router per surface, plus the raw operation explorer
  db/         SQLite schema (27 tables) and access helpers
web/src/      React + Vite; 14 screens
scripts/      generate-operations.mjs, verify.mjs, demo-data.mjs, package-dist.mjs
```

**Storage.** Everything is local: SQLite at `data/etsy-command-center.db`, via
Node's built-in `node:sqlite`. `better-sqlite3` is an optional fallback for
older Node builds; because it is optional, a machine without a C++ toolchain
still installs cleanly. Etsy
mirrors into it so the grids and exports are instant and work offline; Etsy stays
the source of truth and every write goes straight to the API.

**Secrets.** Tokens and API keys are sealed with AES-256-GCM under
`data/master.key` (mode 0600). They are never returned to the browser in full —
the settings screen shows a mask. `data/` is gitignored in its entirety.

**Rate limiting.** A token bucket holds requests to Etsy's published 10/second
ceiling, with backoff on 429 and 5xx, and `Retry-After` honoured.

---

## Verification

```bash
npm start &
npm run verify
```

39 end-to-end checks over the operation catalogue, the SKU grid and pricing maths,
the tracking parser and alert lifecycle, the prompt library, the bulk dry-run,
every Excel export, path-traversal protection, and the error paths that should
fail cleanly when a shop is not connected.

---

## When the browser says the site cannot be reached

`ERR_CONNECTION_REFUSED` on `127.0.0.1:4317` means no server is listening. It is
never a browser or firewall problem — localhost is your own machine.

1. **Is it running?** The terminal (or the launcher window) must still be open
   and showing `Etsy Command Center on http://127.0.0.1:4317`. If you closed it,
   or pressed `Ctrl+C`, start it again.
2. **Did startup fail?** Scroll up in that window — the error is printed there.
   `npm run doctor` will name the problem and the fix.
3. **Is `node` installed?** `node --version` must print v20 or higher. If the
   command is not found, install the LTS build from <https://nodejs.org> and
   open a *new* terminal.
4. **Are you in the right folder?** `npm start` must run from inside the
   `EtsyApp` directory — the one containing `package.json`.
5. **Port already taken?** `npm run doctor` will say so. Use another:
   `PORT=4400 npm start`, then open `http://127.0.0.1:4400`.

## Honest limitations

- **YunTrack publishes no developer API, so the adapter targets the call its own
  tracking page makes.** The request shape, the HMAC-SHA256 signature and the
  status-code table were read off the public page bundle, so they match what the
  site itself sends rather than being guessed — there is a regression test
  pinning the signature to a known vector. `services.yuntrack.com` sits behind an
  Aliyun WAF that rejects some datacentre IPs with a 405 interstitial; that is an
  IP-reputation block, not a bad request, and it is reported as such. Where it
  happens, switch to the **browser provider**, which loads the real
  `parcelTracking?id=` page. **The deep link and the no-movement alert work under
  every provider**, because the alert counts elapsed time rather than depending
  on the feed.
- **Manus is an agent API, not a chat API.** Requests are submitted as tasks and
  polled, so a reply can take minutes, and it does not accept image input. The
  screenshot workflow and image editing therefore need Anthropic or OpenAI.
  Manus also meters by credits — a `credit limit exceeded` response is surfaced
  as exactly that, with a prompt to top up or switch provider.
- **No search-volume data.** Etsy does not expose it; research reports measured
  quantities only.
- **Some endpoints are gated.** A handful require Etsy application review and
  return 403 on a standard app. The explorer flags them from the spec.
