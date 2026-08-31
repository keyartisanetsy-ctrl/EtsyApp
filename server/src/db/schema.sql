PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  is_secret   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth2 (PKCE) state, short lived, one row per in-flight authorisation.
CREATE TABLE IF NOT EXISTS oauth_state (
  state          TEXT PRIMARY KEY,
  code_verifier  TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_token (
  id             INTEGER PRIMARY KEY CHECK (id = 1),   -- single connected shop
  user_id        INTEGER,
  shop_id        INTEGER,
  shop_name      TEXT,
  access_token   TEXT NOT NULL,                        -- sealed
  refresh_token  TEXT NOT NULL,                        -- sealed
  scopes         TEXT NOT NULL DEFAULT '',
  expires_at     TEXT NOT NULL,
  connected_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- listings
CREATE TABLE IF NOT EXISTS listings (
  listing_id        INTEGER PRIMARY KEY,
  shop_id           INTEGER,
  title             TEXT,
  description       TEXT,
  state             TEXT,          -- active | inactive | draft | expired | sold_out
  url               TEXT,
  price_amount      INTEGER,       -- Etsy money: minor units
  price_divisor     INTEGER DEFAULT 100,
  price_currency    TEXT,
  quantity          INTEGER,
  taxonomy_id       INTEGER,
  shop_section_id   INTEGER,
  shipping_profile_id INTEGER,
  return_policy_id  INTEGER,
  tags              TEXT,          -- JSON array
  materials         TEXT,          -- JSON array
  sku_list          TEXT,          -- JSON array (Etsy's rolled-up skus field)
  views             INTEGER,
  num_favorers      INTEGER,
  featured_rank     INTEGER,
  created_ts        INTEGER,
  updated_ts        INTEGER,
  ends_ts           INTEGER,
  first_image_url   TEXT,
  first_image_id    INTEGER,
  raw               TEXT,          -- full Etsy payload
  synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_state ON listings(state);
CREATE INDEX IF NOT EXISTS idx_listings_section ON listings(shop_section_id);
CREATE INDEX IF NOT EXISTS idx_listings_updated ON listings(updated_ts DESC);

CREATE TABLE IF NOT EXISTS listing_images (
  listing_image_id INTEGER PRIMARY KEY,
  listing_id       INTEGER NOT NULL,
  rank             INTEGER,
  url_75x75        TEXT,
  url_570xN        TEXT,
  url_fullxfull    TEXT,
  alt_text         TEXT,
  raw              TEXT,
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_limg_listing ON listing_images(listing_id, rank);

CREATE TABLE IF NOT EXISTS listing_videos (
  video_id   INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL,
  height INTEGER, width INTEGER, thumbnail_url TEXT, video_url TEXT, video_state TEXT,
  raw TEXT
);

-- One row per Etsy "product" (a variation combination) inside a listing.
CREATE TABLE IF NOT EXISTS listing_products (
  product_id       INTEGER PRIMARY KEY,
  listing_id       INTEGER NOT NULL,
  sku              TEXT,
  is_deleted       INTEGER DEFAULT 0,
  property_values  TEXT,          -- JSON array of {property_id,property_name,value_ids,values}
  variation_label  TEXT,          -- flattened "Colour: Red / Size: M" for display + search
  offering_id      INTEGER,
  price_amount     INTEGER,
  price_divisor    INTEGER DEFAULT 100,
  price_currency   TEXT,
  quantity         INTEGER,
  is_enabled       INTEGER DEFAULT 1,
  variation_image_url TEXT,
  variation_image_id  INTEGER,
  raw              TEXT,
  synced_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lp_listing ON listing_products(listing_id);
CREATE INDEX IF NOT EXISTS idx_lp_sku ON listing_products(sku);

-- Which image Etsy shows for a given variation value.
CREATE TABLE IF NOT EXISTS variation_images (
  listing_id  INTEGER NOT NULL,
  property_id INTEGER NOT NULL,
  value_id    INTEGER NOT NULL,
  image_id    INTEGER,
  PRIMARY KEY (listing_id, property_id, value_id)
);

-- Shop-private data attached to a SKU. Never sent to Etsy.
CREATE TABLE IF NOT EXISTS sku_meta (
  sku            TEXT PRIMARY KEY,
  supply_link    TEXT DEFAULT '',   -- informational supplier URL
  supplier_name  TEXT DEFAULT '',
  supply_cost    REAL,
  supply_currency TEXT DEFAULT 'USD',
  lead_time_days INTEGER,
  notes          TEXT DEFAULT '',
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shop_sections (
  shop_section_id INTEGER PRIMARY KEY,
  title TEXT, rank INTEGER, active_listing_count INTEGER, raw TEXT
);

-- Generic cache for reference data (taxonomy, shipping profiles, carriers...).
CREATE TABLE IF NOT EXISTS reference_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------ orders
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id      INTEGER PRIMARY KEY,
  shop_id         INTEGER,
  receipt_type    INTEGER,
  status          TEXT,
  buyer_user_id   INTEGER,
  buyer_email     TEXT,
  name            TEXT,
  first_line      TEXT, second_line TEXT, city TEXT, state TEXT, zip TEXT,
  country_iso     TEXT, formatted_address TEXT,
  message_from_buyer   TEXT,
  message_from_seller  TEXT,
  message_from_payment TEXT,
  is_paid         INTEGER, is_shipped INTEGER,
  was_paid        INTEGER, was_shipped INTEGER, was_delivered INTEGER, was_canceled INTEGER,
  grandtotal_amount INTEGER, grandtotal_divisor INTEGER DEFAULT 100, grandtotal_currency TEXT,
  subtotal_amount INTEGER, total_shipping_amount INTEGER, total_tax_amount INTEGER,
  discount_amount INTEGER, gift_wrap_price_amount INTEGER,
  is_gift         INTEGER, gift_message TEXT,
  payment_method  TEXT,
  created_ts      INTEGER,
  updated_ts      INTEGER,
  shipped_ts      INTEGER,
  expected_ship_ts INTEGER,
  raw             TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_created ON receipts(created_ts DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_shipped ON receipts(was_shipped);

CREATE TABLE IF NOT EXISTS receipt_transactions (
  transaction_id INTEGER PRIMARY KEY,
  receipt_id     INTEGER NOT NULL,
  listing_id     INTEGER,
  product_id     INTEGER,
  sku            TEXT,
  title          TEXT,
  description    TEXT,
  quantity       INTEGER,
  price_amount   INTEGER, price_divisor INTEGER DEFAULT 100, price_currency TEXT,
  shipping_cost_amount INTEGER,
  variations     TEXT,   -- JSON
  image_url      TEXT,
  is_digital     INTEGER,
  paid_ts        INTEGER, shipped_ts INTEGER,
  raw            TEXT,
  FOREIGN KEY (receipt_id) REFERENCES receipts(receipt_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rt_receipt ON receipt_transactions(receipt_id);
CREATE INDEX IF NOT EXISTS idx_rt_sku ON receipt_transactions(sku);

-- The "Done" tick list the shop works from, plus per-order workspace notes.
CREATE TABLE IF NOT EXISTS order_flags (
  receipt_id  INTEGER PRIMARY KEY,
  is_done     INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  is_seen     INTEGER NOT NULL DEFAULT 0,   -- drives the "new order" badge
  seen_at     TEXT,
  is_flagged  INTEGER NOT NULL DEFAULT 0,
  supplier_ordered   INTEGER NOT NULL DEFAULT 0,
  supplier_order_ref TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- tracking
CREATE TABLE IF NOT EXISTS shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id     INTEGER NOT NULL,
  tracking_code  TEXT NOT NULL,
  carrier_name   TEXT,
  pushed_to_etsy INTEGER NOT NULL DEFAULT 0,
  pushed_at      TEXT,
  push_error     TEXT,
  note_to_buyer  TEXT,
  send_bcc       INTEGER DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (receipt_id, tracking_code)
);
CREATE INDEX IF NOT EXISTS idx_ship_code ON shipments(tracking_code);

CREATE TABLE IF NOT EXISTS tracking (
  tracking_code    TEXT PRIMARY KEY,
  receipt_id       INTEGER,
  carrier_name     TEXT,
  provider         TEXT,            -- yuntrack | seventeentrack | manual
  status           TEXT NOT NULL DEFAULT 'pre_shipped',
  -- pre_shipped | in_transit | out_for_delivery | delivered | exception
  --   | pickup_waiting | returned | expired | not_found | alert
  status_detail    TEXT DEFAULT '',
  origin_country   TEXT,
  destination_country TEXT,
  last_event_at    TEXT,
  last_event_text  TEXT,
  last_event_location TEXT,
  event_count      INTEGER DEFAULT 0,
  days_since_move  INTEGER,
  is_stale         INTEGER NOT NULL DEFAULT 0,   -- no movement past the threshold
  alert_reason     TEXT DEFAULT '',
  alert_ack        INTEGER NOT NULL DEFAULT 0,
  delivered_at     TEXT,
  first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at  TEXT,
  check_error      TEXT,
  raw              TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracking_status ON tracking(status);
CREATE INDEX IF NOT EXISTS idx_tracking_stale ON tracking(is_stale);

CREATE TABLE IF NOT EXISTS tracking_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_code TEXT NOT NULL,
  event_at      TEXT,
  description   TEXT,
  location      TEXT,
  status_hint   TEXT,
  fingerprint   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tracking_code, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_tevents_code ON tracking_events(tracking_code, event_at DESC);

-- ---------------------------------------------------------------------- AI
CREATE TABLE IF NOT EXISTS prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,   -- reply | title | description | tags | listing | image | research | custom
  body        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prompts_kind ON prompts(kind, is_default DESC);

CREATE TABLE IF NOT EXISTS ai_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT,
  prompt_id    INTEGER,
  status       TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed
  input        TEXT,
  output       TEXT,
  attachments  TEXT,      -- JSON array of attachment ids
  external_id  TEXT,      -- e.g. Manus task id
  external_url TEXT,
  error        TEXT,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_airuns_kind ON ai_runs(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT,
  size_bytes  INTEGER,
  path        TEXT NOT NULL,
  sha256      TEXT,
  purpose     TEXT,     -- reply-screenshot | listing-image | ai-output
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- bulk jobs
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  label       TEXT,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|completed|failed|canceled
  total       INTEGER NOT NULL DEFAULT 0,
  succeeded   INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  params      TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON bulk_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS bulk_job_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  target_id  TEXT,
  label      TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  request    TEXT,
  response   TEXT,
  error      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES bulk_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobitems_job ON bulk_job_items(job_id, seq);

-- ---------------------------------------------------------------- research
CREATE TABLE IF NOT EXISTS research_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword     TEXT NOT NULL,
  taxonomy_id INTEGER,
  scope       TEXT,
  result_count INTEGER DEFAULT 0,
  summary     TEXT,
  metrics     TEXT,   -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL,
  listing_id  INTEGER,
  title       TEXT,
  shop_name   TEXT,
  price_amount INTEGER, price_currency TEXT,
  views INTEGER, num_favorers INTEGER,
  tags TEXT, url TEXT, image_url TEXT,
  created_ts INTEGER,
  raw TEXT,
  FOREIGN KEY (run_id) REFERENCES research_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rres_run ON research_results(run_id);

-- ------------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  status     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- Rolling record of every Etsy call, for the API Explorer + rate diagnostics.
CREATE TABLE IF NOT EXISTS api_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  operation_id TEXT,
  method       TEXT,
  url          TEXT,
  status       INTEGER,
  duration_ms  INTEGER,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_apicalls_ts ON api_calls(ts DESC);
