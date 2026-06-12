-- 颜色塌缩修复：UNIQUE 再加 color（同 tier+capacity 不同颜色价不同，必须分开存，否则便宜色被覆盖）
-- 目标：S25 512GB Mint / Silver / Navy 各自独立保留，不再互相覆盖。
CREATE TABLE variant_prices_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id     INTEGER NOT NULL,
  item_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL DEFAULT '',
  sku         TEXT    NOT NULL DEFAULT '',
  model       TEXT    NOT NULL DEFAULT '',
  capacity    TEXT    NOT NULL DEFAULT '',
  tier        TEXT    NOT NULL DEFAULT '',
  price       REAL,
  platform    TEXT    NOT NULL DEFAULT 'shopee',
  grabbed_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  voucher_amount REAL NOT NULL DEFAULT 0,
  sold_out    INTEGER NOT NULL DEFAULT 0,
  color        TEXT NOT NULL DEFAULT '',
  variant_name TEXT NOT NULL DEFAULT '',
  UNIQUE(shop_id, item_id, model, tier, capacity, color)
);
INSERT INTO variant_prices_v2
  (shop_id, item_id, title, sku, model, capacity, tier, price, platform, grabbed_at, updated_at, voucher_amount, sold_out, color, variant_name)
SELECT shop_id, item_id, title, sku, model, capacity, tier, price, platform, grabbed_at, updated_at, voucher_amount, sold_out, color, variant_name
FROM variant_prices;
ALTER TABLE variant_prices RENAME TO variant_prices_pre_color;
ALTER TABLE variant_prices_v2 RENAME TO variant_prices;
