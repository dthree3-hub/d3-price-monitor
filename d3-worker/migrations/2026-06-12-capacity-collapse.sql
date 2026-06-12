-- 容量塌缩迁移：UNIQUE 加 capacity；新增 color + variant_name；保留旧数据为 variant_prices_old
CREATE TABLE variant_prices_new (
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
  UNIQUE(shop_id, item_id, model, tier, capacity)
);
INSERT INTO variant_prices_new
  (shop_id, item_id, title, sku, model, capacity, tier, price, platform, grabbed_at, updated_at, voucher_amount, sold_out, color, variant_name)
SELECT shop_id, item_id, title, sku, model, capacity, tier, price, platform, grabbed_at, updated_at, voucher_amount, sold_out, '', ''
FROM variant_prices;
ALTER TABLE variant_prices RENAME TO variant_prices_old;
ALTER TABLE variant_prices_new RENAME TO variant_prices;
