# Project files

One line per file: what it does, and why it exists. The README covers what the
app does for a seller; this covers what each piece of the codebase does for
whoever is reading it next. Grouped by directory, in the order you would
actually go looking.

Generated files are skipped (`web/dist/`, `data/`, `node_modules/`,
`server/src/etsy/operations.generated.js`'s own body — its purpose is covered
below, not its 105-operation contents).

## Top level

| File | What it does |
| --- | --- |
| `package.json` | One workspace, no build step for the server: `npm start` runs everything. Scripts: `start`, `dev` (API + Vite dev server), `doctor`, `fix`, `verify`, `codegen`, `build`, `package`. |
| `START-WINDOWS.bat` / `START-MAC-LINUX.command` | Double-click entry points for someone who will never open a terminal — both just call `npm start` with a working directory fixed to the script's own location. |
| `.env.example` | Every setting the app reads from the environment, documented in place — copied to `.env` on first run. |
| `.gitignore` | Keeps `data/` (the database and secrets), `.env`, `.tools/` (downloaded tunnel binaries) and build output out of git. |

## `server/src/` — top level

| File | What it does |
| --- | --- |
| `index.js` | Builds the Express app, mounts every router under `/api`, serves `web/dist` in production, binds to `config.host`/`config.port` (plus an IPv6 loopback listener), and prints the ready banner + opens a browser. |
| `config.js` | Reads `.env` once and resolves every setting (host, port, Etsy keys, AI keys, data directory) with its defaults, so nothing else in the codebase touches `process.env` directly. |
| `scheduler.js` | Background timers that are not a user request: FX rate refresh, tracking auto-sync, stale-alert recompute, and (opt-in) the auto-update check. |

## `server/src/etsy/` — the Etsy API client

| File | What it does |
| --- | --- |
| `operations.generated.js` | All 105 Etsy Open API v3 operations, generated from Etsy's own OpenAPI document by `scripts/generate-operations.mjs` — never hand-edited. |
| `client.js` | The one function (`call(operationId, params, opts)`) everything else uses to reach Etsy: token refresh, a 10 req/s token bucket, retry with backoff on 429/5xx, `Retry-After` handling, and the call log the API explorer reads. |
| `oauth.js` | OAuth2 authorization-code + PKCE flow for connecting a shop. |
| `shop.js` | Which shop is "active" right now, and the multi-shop scoping helpers (`requireShopId`, `activeShopId`) every shop-owned query goes through. |

## `server/src/services/` — the actual logic

| File | What it does |
| --- | --- |
| `drafts.js` | The draft desk: staging table, field validation against Etsy's real (not just documented) requirements, push to Etsy, category-attribute and personalization side-calls, the AI/rules autofill engine, and the shop's own saved defaults. |
| `draftmedia.js` | Photos/video for a draft that has no real Etsy listing id yet — staged locally, uploaded the moment the draft is sent. |
| `listings.js` | Listing lifecycle once it is real on Etsy: create, update (with dry-run), state changes, images/video/files, personalization, translations, category properties. |
| `inventory.js` | SKU/variation management. Etsy has no per-variation patch endpoint (`PUT .../inventory` replaces the whole array), so every edit here is a read-modify-write that strips the read-only fields Etsy refuses back. |
| `productimages.js` | Which picture belongs to which variant, and re-syncing that mapping from Etsy. |
| `variantimages.js` | Resolving the one photo for the exact option a buyer actually chose, with first/last-image fallback when there is no per-option photo. |
| `sync.js` | Pulls Etsy's own state (listings, images, videos, inventory) into the local SQLite mirror, so the grids/exports are instant and work offline. |
| `orders.js` | The order desk: the working list, the Done/seen/flag columns, the detail view, `was_paid`/`was_shipped` push-back to Etsy. |
| `orderstatus.js` | What state an order is actually in, computed as a set of independent chips (paid, shipped, tracked, delivered, aged) rather than one flag that can only mean one thing. |
| `ordercode.js` | The short human code an order carries on a sheet (e.g. `26-0709-01`) — per day, shared by every line item of one order, stable across re-syncs. |
| `tracking/index.js` | Bulk add, the tracking board, alert lifecycle, carrier lookup (`getShippingCarriers`), manual status overrides. |
| `tracking/yuntrack.js` | The YunTrack adapter: replays the signed request its own tracking page makes, HMAC-SHA256 included — pinned by a regression test against a known vector. |
| `tracking/yuntrack-browser.js` | The same, via a real headless Chromium page load — gets through the WAF that rejects some server-side calls. |
| `tracking/seventeentrack.js` | 17TRACK adapter (paid API key). |
| `tracking/status.js` | The shared status vocabulary and labels every provider maps onto. |
| `bulk.js` | The bulk-action engine: one job type per handler (listing/SKU/order/AI actions), dry-run preview, per-item results, cancel, retry-only-failures. |
| `ai/index.js` | The AI layer: prompt library, customer-reply desk (typed message or screenshot), title/description/tags/whole-listing writers, image studio, provider-agnostic run/complete plumbing. |
| `ai/providers.js` | Manus, Anthropic and OpenAI behind one `complete()` interface, so the rest of the app never branches on which provider is configured. |
| `research.js` | Product research over Etsy's public search (price bands, tag frequency, traction proxy) and the seller-taxonomy search that backs every category picker in the app. |
| `analytics.js` / `reporting.js` | The shop's own numbers for a month-end review, and the figures worth trusting at that review specifically (net of refunds/cancellations). |
| `adcosts.js` / `offsiteads.js` | Ad spend you enter yourself, and Etsy's own Offsite Ads fee worked out per order under the published rules. |
| `fx.js` | Daily exchange rates, kept for the last few months so an order in another currency is valued at its own day's rate, not today's. |
| `skugen.js` | Making up SKUs, either by a fixed rule or by asking the AI, for variations that do not have one yet. |
| `excel.js` | Real `.xlsx` exports via ExcelJS — frozen headers, auto-filters, typed cells, clickable links, alert rows highlighted. |
| `airtable.js` | Airtable client, destination/field-mapping config, and the push engine (see `docs/AIRTABLE.md`). |
| `batchapi.js` | Etsy's own batch-fetch endpoints, plus odds and ends (like `getListingPersonalization`) that had no other natural home. |
| `productstudio.js` | The bridge from Product Studio (the Taobao/1688 companion app) into this one: reads whatever shape a product arrives in and lands it on the draft desk with sensible defaults filled in. |
| `taobao.js` | The supply side — Taobao/1688 supplier links, kept per SKU, private to this machine. |
| `addresscheck.js` | AI-assisted read of a shipping address before it becomes a lost parcel. |
| `undo.js` | Ctrl+Z for local changes — every mutating action registers what it did so it can be reversed; pushes to Etsy are recorded as history but cannot be taken back, since Etsy already has them. |
| `settings.js` | Every app setting resolves DB → `.env` → built-in default, in that order, so Settings screen is a straight read/write over the same source of truth the rest of the app reads. |

## `server/src/routes/` — one Express router per surface

Thin: parse the request, call a service function, return JSON. 21 files, one
per area shown in the sidebar (`drafts.js`, `listings.js`, `orders.js`,
`tracking.js`, `skus.js` → inventory, `bulk.js`, `ai.js`, `research.js`,
`airtable.js`, `analytics.js`, `finance.js`, `exports.js`, `supply.js`,
`settings.js`, `shop.js`, `auth.js`, `undo.js`, `dashboard.js`, `integrations.js`
→ Product Studio, `etsy.js` → the raw API explorer, `etsyextra.js` → the
handful of operations with no dedicated screen).

## `server/src/db/`

| File | What it does |
| --- | --- |
| `schema.sql` | The full SQLite schema — 38 tables. |
| `migrate.js` | Applies `schema.sql` and any incremental column additions on startup; safe to run against an already-current database. |
| `driver.js` | Picks `node:sqlite` (Node's own, no native build needed) or falls back to `better-sqlite3` on older Node, behind one identical interface. |
| `index.js` | Shared helpers used everywhere: `getDb()`, `json`/`parse`, `audit()`, and the generic `getSetting`/`setSetting`/`deleteSetting` key-value store settings and the draft desk's own saved defaults both sit on top of. |

## `server/src/lib/`

| File | What it does |
| --- | --- |
| `crypto.js` | AES-256-GCM sealing for tokens/API keys under `data/master.key` (mode 0600) — never returned to the browser in full. |
| `errors.js` | `badRequest`/`notFound`/`EtsyApiError` — typed errors the route layer turns into consistent JSON. |
| `http.js` | Request-parsing helpers (`int`, `bool`, `list`, `required`, `asyncRoute`) shared by every router. |
| `logger.js` | One `createLogger(name)` per module, consistent timestamped output. |
| `money.js` | Money math shared everywhere a price or a discount is computed, so rounding is done in exactly one place. |
| `open-browser.js` | Opens the default browser to the app's URL once the server is actually listening — opt out with `OPEN_BROWSER=0`. |
| `outbound.js` | The privacy layer: strips identifying headers from every outbound request and applies the configured proxy, if any. |

## `web/src/pages/` — one file per sidebar screen (17)

| File | Screen |
| --- | --- |
| `Dashboard.jsx` | Landing page: shop summary stats, quick sync buttons, recent activity. |
| `Drafts.jsx` | The draft desk — see the README section of the same name. Also hosts the Product Studio connection modal and the shop-defaults editor. |
| `NewListing.jsx` | Create a listing from scratch; hands off to the draft desk afterward for photos and further edits. Also exports `CategoryPicker`, the text-search category box every other screen with a category field reuses. |
| `Listings.jsx` | The catalogue: every state, bulk selection, and the full-field edit drawer (mirrors the draft desk's field coverage for a listing that already exists on Etsy). |
| `Skus.jsx` | One row per variation: both prices, supply link, margin, first image and the variant's own image. |
| `Orders.jsx` | The order desk: Done/seen/flag columns, detail panel, per-order tracking + carrier form, filters. |
| `Tracking.jsx` | The parcel board: bulk add, statuses, stale-alert list, carrier lookup. |
| `BulkJobs.jsx` | History and live status of every bulk-action job, with per-item results. |
| `Research.jsx` | Keyword research over Etsy's public search. |
| `Analytics.jsx` | Shop numbers, filterable, with ad spend entry. |
| `AiStudio.jsx` | Customer replies, listing writers, and the image studio, in one tabbed screen. |
| `Prompts.jsx` | The saved-prompt library behind the AI screens. |
| `Supply.jsx` | The Taobao/1688 supply book, keyed by SKU. |
| `Airtable.jsx` | Destination setup, column mapping (by name or by AI), and manual push. |
| `Exports.jsx` | The five `.xlsx` export kinds. |
| `ShopSettings.jsx` | Shop-side Etsy config: sections, shipping profiles, return policies, holiday preferences, production partners, reviews. |
| `Settings.jsx` | App-wide settings, grouped, auto-rendered from `SETTING_DEFS` on the server. |
| `ApiExplorer.jsx` | Every one of the 105 generated operations, searchable and directly callable — the escape hatch for anything without a purpose-built screen. |

## `web/src/components/` and `web/src/lib/`

| File | What it does |
| --- | --- |
| `components/Page.jsx` | Page chrome shared by every screen (`Page`/`TablePage`): title, subtitle, action buttons. |
| `components/ui.jsx` | The shared UI kit — `Spinner`, `Banner`, `Modal`, `Drawer`, `Checkbox`, `Thumb`, `Tabs`, `CopyButton`, the `useAsync`/`useToast`/`useDebounced` hooks, and the `fmt*` formatters. Nearly every page imports from here. |
| `components/Pictures.jsx` | Read-only photo viewer with per-variant/first/last resolution and copyable links; `ListingMedia` in `Listings.jsx` is the sibling upload UI for an already-real listing's photos. |
| `components/Undo.jsx` | The floating Ctrl+Z control, reading from `server/src/services/undo.js`. |
| `lib/api.js` | The one `fetch()` wrapper every page uses (`get`/`post`/`put`/`patch`/`del`/`upload`) — auth header, JSON parsing, error normalisation in one place. |
| `lib/rates.js` | Client-side FX display helpers. |
| `App.jsx` / `main.jsx` | Router setup, the password gate, top-level layout. |

## `scripts/`

| File | What it does |
| --- | --- |
| `start.mjs` | `npm start`'s actual entry point: installs/builds on a fresh clone if needed, starts the server, and (opt-in) starts the public-link tunnel afterward. |
| `generate-operations.mjs` | Regenerates `server/src/etsy/operations.generated.js` from Etsy's OpenAPI document — run after `docs/etsy-oas.json` changes. |
| `verify.mjs` | The end-to-end check suite described under Verification, above. |
| `demo-data.mjs` | Loads (or clears) obviously-fake sample data, for looking around before connecting a real shop. |
| `doctor.mjs` | Diagnoses a broken local setup (Node version, missing deps, missing build, port conflicts, permissions) and says exactly what is wrong. |
| `package-dist.mjs` | Builds the distributable package for `npm run package`. |
| `remote-access.mjs` | The Cloudflare Tunnel path for `REMOTE_ACCESS=1` — downloads `cloudflared` once, opens a quick tunnel, verifies the link actually answers before printing it, retries with a fresh tunnel if it does not. |
| `pinggy-tunnel.mjs` | The default `REMOTE_ACCESS=1` path — an outbound SSH connection to Pinggy's free tier, reconnecting automatically (with a fresh address) every time that connection ends, for as long as the app keeps running. |
| `self-update.mjs` | `AUTO_UPDATE=1`'s logic: checks this repo's branch on GitHub, downloads and applies a newer commit over the running install without touching `.env`/`data/`. |

## `deploy/`

| File | What it does |
| --- | --- |
| `setup-vds.ps1` | One-shot Windows Server setup: Node, the app, a generated password, and both the app and a Cloudflare Tunnel registered as NSSM services that survive reboots. Safe to re-run. |
| `setup-vds.sh` | The Linux equivalent, fronted by Caddy with automatic HTTPS via a free `nip.io` hostname, registered as a systemd service. |
| `Caddyfile.example` / `etsy-command-center.service.example` | Reference configs the Linux script generates from — useful to read even if you never run the script by hand. |

## `docs/`

| File | What it covers |
| --- | --- |
| `SETUP.md` | Full first-connection walkthrough: Etsy app credentials, OAuth, first sync. |
| `AIRTABLE.md` | The Airtable integration in full — column matching, keyed updates, computed columns. |
| `REMOTE-ACCESS.md` | Both remote-access paths in full: the one-click Pinggy/Cloudflare link, and the always-on VDS setup scripts. |
| `PROJECT-FILES.md` | This file. |
| `etsy-api-coverage.md` | Every one of the 105 generated operations, which screen (if any) uses it. |
| `etsy-oas.json` | Etsy's own OpenAPI document, as fetched — the single source `generate-operations.mjs` reads from. |
