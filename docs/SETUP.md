# Setup

## 1. Requirements

- **Node.js 20.11 or newer** (`node --version`). Node 22 LTS is what this was built against.
- A C toolchain for the SQLite driver. Most machines already have one; if
  `npm install` fails compiling `better-sqlite3`, install build tools:
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Windows: `npm i -g windows-build-tools`, or use WSL

## 2. Install

```bash
npm install
npm run codegen     # generates the Etsy client from docs/etsy-oas.json
npm run build       # builds the web app into web/dist
```

## 3. Register an Etsy app

1. Go to <https://www.etsy.com/developers/your-apps> and create an app.
2. Copy **both** the **keystring** and the **shared secret**. Both are required:
   Etsy's `x-api-key` header must be `keystring:shared_secret`, and the
   keystring on its own is rejected with a 403 on every endpoint. (The OAuth
   `client_id` is the bare keystring — the app handles that distinction.)
3. Add this callback URL to the app, **exactly**:

   ```
   http://127.0.0.1:4317/api/auth/callback
   ```

   Etsy matches this string literally. `localhost` is *not* the same as
   `127.0.0.1`, and a trailing slash will break the exchange.

## 4. Add your credentials

Either paste them into **Settings → Etsy connection** in the running app
(stored encrypted in the local database — recommended), or copy `.env.example`
to `.env` and fill it in:

```bash
cp .env.example .env
```

## 5. Start and connect

```bash
npm start           # http://127.0.0.1:4317
```

Press **Test connection** first — it pings Etsy and tells you whether the key is
accepted before you start the OAuth dance. Then **Connect Etsy shop**. Etsy opens in a new tab and lists the
permissions being requested. Approve, and the tab confirms the connection.

The app requests every scope Etsy defines so no feature fails later for want of
permission. To narrow that, pass a `scopes` array to `POST /api/auth/connect`.

## 6. First sync

Dashboard → **Sync everything**. This pulls listings in all five states, every
variation and its images, shop sections, and recent orders. On a large catalogue
the first run takes a few minutes because inventory is one call per listing;
later syncs are incremental.

---

## Configuration

Every setting can be changed in the app; `.env` is the fallback for headless
deployments. Settings resolve **database → `.env` → built-in default**.

| Setting | Default | What it does |
|---|---|---|
| `pricing.discount_percent` | `30` | The sale column shown next to every non-discount price |
| `tracking.stale_days` | `4` | Raise an alert after this many days without movement |
| `tracking.url_template` | `https://www.yuntrack.com/parcelTracking?id={code}` | Where tracking numbers link |
| `tracking.provider` | `yuntrack` | `yuntrack`, `seventeentrack`, or `manual` |
| `tracking.sync_minutes` | `180` | Background carrier polling interval |
| `ai.provider` | `manus` | Default AI provider |
| `orders.default_carrier` | — | Carrier used when a bulk tracking row omits one |

## AI providers

| | Manus | Anthropic | OpenAI |
|---|---|---|---|
| Text | yes | yes | yes |
| Reads screenshots | no | yes | yes |
| Image editing | no | no | yes |
| Latency | minutes (agent tasks) | seconds | seconds |

The app picks a provider that can actually do the job and says so when it falls
back. For the screenshot reply workflow, configure Anthropic or OpenAI.

Manus meters by credits. If the account is out, the API returns
`credit limit exceeded` and the app shows that verbatim rather than a generic
failure.

## Tracking providers

The tracking link is the primary mechanism and always works:
`tracking.url_template` defaults to
`https://www.yuntrack.com/parcelTracking?id={code}`, with `{code}` substituted
per parcel. Point it anywhere else if you change tracker.

For *automatic* status, pick a provider under `tracking.provider`:

### `yuntrack` — direct query (default)

YunTrack has no developer API, so this replays the exact call its own tracking
page makes: `POST services.yuntrack.com/Track/Query` with
`{NumberList, CaptchaVerification, Timestamp, Signature}`, where `Signature` is
`HMAC-SHA256("Timestamp=<ts>&NumberList=<json>")`. The status codes are theirs
(`10` Processing, `20`/`30` Transit, `50` Delivered, `40`/`60`/`70`/`100` Alert,
`90` Returned, `0` Not Found).

That host sits behind an Aliyun WAF. If it answers `405` with an HTML
interstitial, your IP is being refused on reputation — the numbers and the
request are fine. The app says exactly that instead of reporting a generic
failure. Home and office connections are usually fine; cloud servers and VPNs
often are not.

### `yuntrack-browser` — the same page, in a real browser

Loads `https://www.yuntrack.com/parcelTracking?id=<code>` in headless Chromium
and reads the tracking data the page fetches for itself. Because it is a genuine
browser session it gets past the WAF that refuses direct calls.

```bash
npm install playwright && npx playwright install chromium
```

Then set `tracking.provider` to `yuntrack-browser`. If a captcha appears, set
`tracking.browser_headed` to `true` once, solve it, and switch back. It loads one
page per parcel, so it is slower — leave the background sync at its default
interval rather than polling hard.

### `seventeentrack` — paid API

Works from any network. Add a key under `tracking.seventeentrack_key`.

### `manual`

No automatic lookups. Set each status from the parcel drawer.

**Under every provider**, the deep link works and the no-movement alert keeps
firing, because it counts elapsed time since the last known movement rather than
waiting on a carrier reply.

## Exposing beyond localhost

The app binds to `127.0.0.1` and has no user accounts, because it is designed to
run on the operator's own machine. If you must expose it:

1. Set `APP_PASSWORD` in `.env`. Every `/api` route then requires it.
2. Set `HOST=0.0.0.0`.
3. Put it behind HTTPS — the password is sent as a header or cookie.
4. Update `ETSY_REDIRECT_URI` and the Etsy app's callback to the public URL.

## Backups

Everything lives in `data/`:

- `etsy-command-center.db` — all local state
- `master.key` — the key your credentials are encrypted with
- `uploads/`, `exports/`

Back up the whole folder. Without `master.key` the stored credentials cannot be
read and you will have to re-enter them (nothing else is lost).

## Troubleshooting

**`invalid_request` / `redirect_uri mismatch` when connecting**
The callback URL on the Etsy app must match byte for byte. Check for
`localhost` vs `127.0.0.1`, http vs https, and a trailing slash.

**`403 Shared secret is required in x-api-key header`**
The shared secret is missing. Etsy needs `x-api-key: keystring:shared_secret`.
Add it in Settings and press Test connection.

**`Etsy 403` on a specific operation**
Either the token lacks the scope (Settings shows what was granted), or the
endpoint is one Etsy gates behind an application review. The API explorer marks
gated endpoints.

**`better-sqlite3` fails to install**
It compiles native code. Install the build tools listed above and retry, or
`npm rebuild better-sqlite3`.

**Inventory update rejected**
Etsy validates the whole product array. The app strips read-only fields and
preserves the `*_on_property` arrays, but Etsy also rejects prices outside the
listing's currency range and duplicate property combinations. The error panel
shows Etsy's own message.

**Bulk job shows failures**
Open the job. Every item keeps its own error. Fix the cause and press
**Retry failed** — it re-runs only those.
