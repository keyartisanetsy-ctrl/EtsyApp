# Airtable sync

Send the orders of the shop you are currently in straight into your own Airtable
tables — with one button, or automatically after every sync.

Everything here is per shop. Switch shops in the sidebar and you see that shop's
destinations, and the orders that get sent are that shop's orders.

---

## 1. Connect

1. Go to <https://airtable.com/create/tokens> and create a **personal access token**.
2. Give it these scopes:

   | Scope | Why |
   |---|---|
   | `data.records:read` | check what is already in the table |
   | `data.records:write` | add, update and delete rows |
   | `schema.bases:read` | read your column names and types, so mapping works |

3. Under **Access**, add the bases you want to write to (or "all current and future bases").
4. Paste the token into **Airtable sync → 1. Connect Airtable** and press **Save token**.

The token is stored encrypted in your local database, next to your Etsy keys. It
never leaves your machine except in the `Authorization` header of calls to
`api.airtable.com`.

## 2. Make a destination

A **destination** is one Airtable table plus the rules for filling it in. Make one
per sheet. Press **+ New destination**, then:

- **Base / Table** — read live from your account.
- **View** — optional, and only a label. Rows always go into the *table*; a view is
  just a filter Airtable applies afterwards. So if you keep one view per shop
  (KeyArtisann / KeyArtisanUS / CutieGiftsUS all on one table), do not pick the
  view — instead fill the column the view filters on. See *Fixed values* below.
- **One Airtable row per**
  - **Item** — a row for every product line in the order. Pick this when the table
    has SKU, Quantity or Variant columns (this is what the "Siparişler Etsy" sheet
    wants).
  - **Order** — one row per order, with the items joined together.

## 3. Match the columns

Two ways, and they produce the same editable result — nothing is saved until you
press **Save destination**.

### Match by name

Instant, offline, and explainable. It normalises both sides (Turkish letters,
accents, punctuation, capitals) and knows the usual names in English and Turkish:

| Your column | gets |
|---|---|
| `Order ID`, `Sipariş No`, `Order Number` | the Etsy order number |
| `Sale Date`, `Order date`, `Tarih` | the order date |
| `Takip No`, `Tracking number`, `Kargo Takip` | the tracking number |
| `MAĞAZA`, `Shop`, `Store` | the shop name |
| `Ship Zipcode`, `Posta Kodu` | the post code |
| `BAŞLIK İLK 40` | the product title cut to 40 characters |
| `Ürün Tedarik Link`, `Buying URL` | the supplier link from your SKU manager |
| `KOD`, `Sipariş Kodu` | the short order code |
| `Month`, `Ay` | the month, as `2026 Eylül` |
| `Yuan - USD Kur`, `Kur` | the yuan rate on the order date |
| `Shipping Cost Yuan`, `Kargo Maliyeti` | what the parcel cost you |
| `Varyant Görsel` | the variant photo URL |
| `Image URL`, `Görsel` | the best available photo URL |
| `NOT 1` | what the **buyer** wrote |
| `NOT 2` | **your own** note |

Each match shows *why* it matched underneath the column name. A guessed match
claims a source only once, so two columns that merely look alike will not both
silently grab the same value — the second is left for you to decide.

### Match with AI

Sends your column names and types, plus the list of fields this app can provide
and one real sample order, to whichever AI provider you have configured. The
answer is checked before you see it: any column or field the model invented is
thrown away, computed columns are refused, and anything left over is listed as
"ignored from the AI answer". You still get a normal, editable mapping.

### Fixed values

Any column can be set to **the same fixed value every time** instead of a field.
This is how one shared table serves several shops: set `MAĞAZA` to `KeyArtisanUS`
on that shop's destination, and its rows land in that shop's view.

### The key column

Tick **Key** on the column holding the order number (up to three columns). That is
how Airtable recognises a row it already has, so sending the same order twice
updates its row instead of adding a second one. Without a key, every send adds new
rows.

## 4. Send

On the **Orders** screen, tick the orders you want and press **⇉ Send to Airtable**.
Before anything is written you get a preview of the exact values, a count of new
versus existing rows, and a warning listing any column that will stay empty and why.

Three modes:

| Mode | Does |
|---|---|
| Add new rows, update ones already there | the normal one-click send |
| Only update rows sent before | refresh rows already in Airtable, add nothing |
| Delete the rows sent before | remove the rows this app created for those orders |

The app remembers which Airtable record each order became, so updates and deletes
stay accurate even if someone edits the key column inside Airtable.

### Automatically

Settings → `airtable.auto_push` → *Yes*. After every order sync, new orders are
sent to the default destination. If Airtable is unreachable the Etsy sync still
succeeds and the failure is logged — your orders are saved locally either way.

---

## Fields worth knowing about

Beyond the plain order fields, the catalogue carries a few that are computed for you.

### Short order code (KOD)

`26-0709-01` — two-digit year, day and month, then the order's position within that day.
It is worked out from the order's **own** date, assigned once and stored, so:

- every item of the same order carries the **same** code (matching its order number), and
- a code already sitting in Airtable is never renumbered later.

Change the shape in Settings with `orders.code_template` — `{YY} {YYYY} {DD} {MM}` and `{NN}`
(the number of `N`s sets the padding).

### Month

`2026 Eylül` — the month the order arrived, in the same shape these sheets already use.
`Month of the order (September 2026)` is there if you want English instead.

### Exchange rates and USD totals

The app keeps the last ~3 months of daily rates from the European Central Bank and values
**every order at the rate of the day it arrived**, not today's rate. The ECB publishes on
working days only, so an order that lands on a weekend uses the previous working day —
the Airtable page shows which day each rate came from.

| Field | Gives |
|---|---|
| `Yuan → USD rate on the order date` | e.g. `0.149011`, for a "Yuan - USD Kur" column |
| `Lira → USD rate on the order date` | the same for TRY |
| `Order total in USD`, `Subtotal in USD` | the totals converted at that day's rate |
| `Unit price in USD` | one unit, converted |

This is what to use for **KeyArtisann**, where Etsy bills in lira: map `Subtotal in USD`
into the Order Total column and the sheet gets dollars, converted at the right day's rate.

### Shipping cost

Type what a parcel cost you straight into the **Shipping cost** column on the Tracking
screen, next to its tracking number. It comes back as `Shipping cost you paid` and
`Shipping cost in USD` (converted at the order-date rate).

### Variant image

`Variant image URL` is the photo Etsy has against the exact option the buyer chose, which
is usually the right colour — unlike the first listing photo. `Best available image URL`
uses that when it exists and falls back to the listing photo, so a row always has a picture.
Both are plain URLs; point an Airtable automation at the column to turn it into an attachment.

The app fetches these automatically before a push that needs them, reusing whatever the
catalogue sync already downloaded so it usually costs no extra API call.

### Variant text

`Variant (what the buyer picked)` gives just the values — `Silver / 8 US`, no option titles.
The long form is still available as `Variant with option titles`. HTML entities Etsy sends
(`&#039;`) are turned back into real characters (`'`) everywhere, titles included.

## Etsy and Shopify defaults

Each destination belongs to a **sheet family** — Etsy or Shopify — and each family keeps its
own default, so one click can go to either sheet without reconfiguring anything.

## Things that are handled for you

- **Computed columns** (formula, rollup, lookup, count, autoNumber, AI text) are
  never written to — Airtable rejects them. They appear greyed out as
  "Airtable calculates this column".
- **Select columns** get their missing options created automatically, which is what
  makes an `Order ID` column of type *single select* work. Turn this off per
  destination if you would rather the send fail than have new options appear.
- **Linked-record columns** (like `SKU` pointing at your stock table) are left alone
  unless you tick **Fill linked-record columns too**, because Airtable creates a row
  in the linked table when it finds no match.
- **Types are converted**: dates become `YYYY-MM-DD`, currency and number columns get
  real numbers (`$1,234.50` → `1234.5`), multi-selects get arrays, checkboxes get
  true/false. A value that genuinely is not a number is skipped rather than written
  as `0`.
- **Empty values are skipped** by default, so a blank in this app never wipes something
  you typed in Airtable. Change it per destination with *Write blanks*.
- **Rate limits**: Airtable allows 5 requests/second per base and 10 records per write.
  The client paces itself, batches by 10, and waits out a 429 the way Airtable asks.

## Using the same setup elsewhere

- **Another Etsy shop** — connect it in Settings, switch to it, and make a destination.
  Point it at the same table with a different fixed shop value, or at a different table.
  Or tick *available to every connected shop* to share one destination.
- **A different table entirely** (for example your website's `Orders` table) — just add
  a second destination; a shop can have as many as you like.
- **Shopify** — this app only reads Etsy, so it cannot push Shopify orders yet. Options,
  cheapest first: Airtable's own Shopify sync, a Zapier/Make scenario, or adding a
  Shopify source to this app so the same mapping and one-click send work for it too.
