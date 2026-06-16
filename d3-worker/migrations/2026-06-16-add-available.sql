-- 新增 available 列：标记该 variant 在页面上是否可买/可选。
-- 1 = 可买/可选（默认）；0 = 灰掉/不可选（is_grayout=true 或 is_clickable=false）。
-- 灰款不再被 scraper 丢弃，而是带 available=0 写库；前端据此判断
-- 「整 capacity / 整 model 全灰」→ 显示 Not Available（单颜色灰仍由前端忽略）。
-- 单列加默认值，SQLite 直接 ADD COLUMN 即可，无需重建表。
ALTER TABLE variant_prices ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
