-- D3 Price Monitor — D1 Schema
-- Migration: 001_initial

CREATE TABLE IF NOT EXISTS variant_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id     INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  sku         TEXT    NOT NULL DEFAULT '',   -- normalized model key, e.g. "S25 Ultra 256GB"
  model       TEXT    NOT NULL DEFAULT '',
  capacity    TEXT    NOT NULL DEFAULT '',
  tier        TEXT    NOT NULL DEFAULT '',   -- Promo / SET A / Basic / …
  price       REAL,
  platform    TEXT    NOT NULL DEFAULT 'shopee',
  grabbed_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop_id, item_id, model, tier)
);

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id     INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  sku         TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL DEFAULT '',
  tier        TEXT    NOT NULL DEFAULT '',
  price       REAL    NOT NULL,
  platform    TEXT    NOT NULL DEFAULT 'shopee',
  grabbed_at  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vp_model_tier  ON variant_prices(model, tier, shop_id);
CREATE INDEX IF NOT EXISTS idx_vp_grabbed     ON variant_prices(shop_id, grabbed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ph_model_time  ON price_history(model, tier, grabbed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ph_shop_time   ON price_history(shop_id, grabbed_at DESC);
