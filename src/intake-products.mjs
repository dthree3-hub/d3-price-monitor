// Product Intake — Hermes 接入接口（Phase 1：inert，未接入 sweep）。
//
// 背景：网页「Product Intake」页面手动新增要监控的新商品（存浏览器 localStorage），
// 通过页面上的「Export Active Products」按钮导出成 product-intake.csv。把它放到 Hermes 机器的
// config/ 下，本模块即可把里面 status=Active 的商品读成与 loadProducts() 同形状的行对象。
// 同时兼容旧的 config/products.csv 同表头格式（intakeRowsFromCsv 按表头自动判别）。
//
// ⚠️ Phase 1 不接入现有 sweep：本文件不被 runOnce/hermes 调用，纯函数 + 测试，零副作用。
// Phase 2 接入只需在抓取前做一次合并（见文件底部 wireIntoSweep 注释），失败只影响新商品。
import fs from 'node:fs';
import path from 'node:path';

// 与 config/products.csv 一致的列；loadProducts() 也是按这套表头解析。
export const INTAKE_CSV_HEADER = [
  'our_product', 'our_price', 'competitor', 'store_url',
  'keyword', 'product_url', 'variant', 'status', 'last_confirmed',
];

// Product Intake 页面「Export Active Products」导出的自描述列（v2 格式）。
// 这套更贴近 localStorage 字段，是给 Leon 看的导出/导入格式；本模块也直接读它。
export const PRODUCT_INTAKE_CSV_HEADER = [
  'merchant', 'item_id', 'shop_id', 'model_name', 'ram', 'storage', 'category', 'shopee_url', 'status',
];

// 把 product-intake v2 格式的一行映射成 loadProducts() 同形状的行对象。
function mapIntakeV2Row(row) {
  return {
    our_product: row.model_name,
    our_price: '0',
    competitor: row.merchant,
    store_url: '',
    keyword: row.model_name,
    product_url: row.shopee_url,
    variant: [row.ram, row.storage].filter(Boolean).join(' '),
    status: row.status,
    last_confirmed: '',
  };
}

// 轻量 CSV 解析（与 lib-hermes 同语义；自带一份避免耦合/改坏现有模块）。
export function parseIntakeCsv(text) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') { quoted = false; }
      else { cell += c; }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 把 intake CSV 文本映射成与 loadProducts() 同形状的行对象，并套用同样的过滤：
// 必须有 product_url，且 status 为空或 'active'。表头缺失时按 INTAKE_CSV_HEADER 兜底。
export function intakeRowsFromCsv(text) {
  const rows = parseIntakeCsv(String(text || ''));
  if (!rows.length) return [];
  const header = rows[0].map((c) => String(c || '').trim());

  // v2 格式（页面 Export Active Products）：表头含 shopee_url/merchant → 映射到 loadProducts 形状。
  if (header.includes('shopee_url') || header.includes('merchant')) {
    return rows.slice(1)
      .filter((row) => row.some((cell) => String(cell || '').trim()))
      .map((row) => Object.fromEntries(PRODUCT_INTAKE_CSV_HEADER.map((key, idx) => [key, String(row[idx] || '').trim()])))
      .map(mapIntakeV2Row)
      .filter((row) => row.product_url && (!row.status || row.status.toLowerCase() === 'active'));
  }

  // 旧格式：与 config/products.csv 同表头（缺表头时按 INTAKE_CSV_HEADER 兜底）。
  const useHeader = header.includes('product_url') ? header : INTAKE_CSV_HEADER;
  const body = header.includes('product_url') ? rows.slice(1) : rows;
  return body
    .filter((row) => row.some((cell) => String(cell || '').trim()))
    .map((row) => Object.fromEntries(useHeader.map((key, idx) => [key, String(row[idx] || '').trim()])))
    .filter((row) => row.product_url && (!row.status || row.status.toLowerCase() === 'active'));
}

// Hermes 侧入口：读 intake CSV（默认 config/product-intake.csv），返回可直接 append 到
// loadProducts() 结果的行数组。文件不存在/读失败 → 返回 []（绝不抛，避免影响整轮 sweep）。
// onError(可选)：读/解析失败时回调（用来打 warning），不传则静默。
export function loadIntakeProducts(csvPath, onError) {
  const file = csvPath || path.join(process.cwd(), 'config', 'product-intake.csv');
  try {
    if (!fs.existsSync(file)) return [];
    return intakeRowsFromCsv(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (typeof onError === 'function') onError(e);
    return [];
  }
}

// 合并去重用的 key：优先 merchant(=competitor) + item_id；解析不到 item_id → merchant + product_url。
// base/intake 两边都是 loadProducts() 形状（competitor / product_url），所以同一套 key。
function productKey(p) {
  const merchant = String((p && p.competitor) || '').trim().toLowerCase();
  const url = String((p && p.product_url) || '').trim();
  const m = url.match(/i\.(\d+)\.(\d+)/) || url.match(/product\/(\d+)\/(\d+)/);
  const itemId = m ? m[2] : '';
  return itemId ? `${merchant}::i::${itemId}` : `${merchant}::u::${url.toLowerCase()}`;
}

// 合并 base(products.csv)与 intake(product-intake.csv)：base 原样全保留（顺序/数量不变），
// intake 逐条去重后追加（与 base 或前面的 intake 撞 key 就跳过）。base 为空数组 → 返回 intake。
// 关键不变量：mergeProducts(base, []) 与 base 完全等价 → intake 文件缺失时现有 sweep 零影响。
export function mergeProducts(base, intake) {
  const baseArr = Array.isArray(base) ? base : [];
  const intakeArr = Array.isArray(intake) ? intake : [];
  const seen = new Set(baseArr.map(productKey));
  const out = baseArr.slice();
  for (const p of intakeArr) {
    const k = productKey(p);
    if (seen.has(k)) continue; // 与 base 或已加入的 intake 重复 → 跳过
    seen.add(k);
    out.push(p);
  }
  return out;
}

// 给 Hermes sweep 用的总入口：base + intake 合并去重、打统一日志、绝不 crash。
//   loadSweepProducts(loadProducts(), { log: logHermes })
// - intake 文件缺失/读失败 → intake=[]，base 照旧（loadIntakeProducts 已吞错，这里再兜一层）。
// - 日志：[products] base=.. intake=.. merged=.. skipped_duplicates=..
export function loadSweepProducts(baseProducts, { log = () => {}, csvPath } = {}) {
  const base = Array.isArray(baseProducts) ? baseProducts : [];
  let intake = [];
  try {
    intake = loadIntakeProducts(csvPath, (e) => log(`[products] WARN intake 读取/解析失败，已忽略: ${(e && e.message) || e}`));
  } catch (e) {
    log(`[products] WARN intake 读取/解析失败，已忽略: ${(e && e.message) || e}`);
    intake = [];
  }
  const merged = mergeProducts(base, intake);
  const skipped = (base.length + intake.length) - merged.length;
  log(`[products] base=${base.length} intake=${intake.length} merged=${merged.length} skipped_duplicates=${skipped}`);
  return merged;
}

// 远程 intake：从 Worker GET /api/intake 拉「页面实时推送的 Active 商品镜像」。
// 返回 loadProducts() 同形状的行数组；URL 未配置/拉取失败 → []（绝不抛，不影响整轮 sweep）。
// Worker 返回的 products[] 列名与 PRODUCT_INTAKE_CSV_HEADER 一致，直接走 mapIntakeV2Row。
export async function fetchIntakeProducts(remoteUrl, onError, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  if (!remoteUrl || typeof fetchImpl !== 'function') return [];
  try {
    const res = await fetchImpl(remoteUrl, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const arr = Array.isArray(body && body.products) ? body.products : [];
    return arr
      .map(mapIntakeV2Row)
      .filter((row) => row.product_url && (!row.status || row.status.toLowerCase() === 'active'));
  } catch (e) {
    if (typeof onError === 'function') onError(e);
    return [];
  }
}

// async 总入口：base + intake 文件(config/product-intake.csv) + intake 远程(/api/intake) 三方合并去重。
// remoteUrl 来自 env HERMES_INTAKE_URL；不传则等价于 loadSweepProducts（纯文件版，行为不变）。
// 任一来源失败只 warning，base 永远原样保留 → 缺文件/无网时现有 sweep 零影响。
export async function loadSweepProductsAsync(baseProducts, { log = () => {}, csvPath, remoteUrl, fetchImpl } = {}) {
  const base = Array.isArray(baseProducts) ? baseProducts : [];
  let intake = [];
  try {
    intake = loadIntakeProducts(csvPath, (e) => log(`[products] WARN intake 文件读取/解析失败，已忽略: ${(e && e.message) || e}`));
  } catch (e) {
    log(`[products] WARN intake 文件读取/解析失败，已忽略: ${(e && e.message) || e}`);
  }
  let remote = [];
  if (remoteUrl) {
    remote = await fetchIntakeProducts(remoteUrl, (e) => log(`[products] WARN intake 远程拉取失败，已忽略: ${(e && e.message) || e}`), fetchImpl);
  }
  const merged = mergeProducts(mergeProducts(base, intake), remote);
  const skipped = (base.length + intake.length + remote.length) - merged.length;
  log(`[products] base=${base.length} intake_file=${intake.length} intake_remote=${remote.length} merged=${merged.length} skipped_duplicates=${skipped}`);
  return merged;
}

// ── Phase 2 已接入（src/runOnce.mjs）──────────────────────────────
// runOnce() 与 runSweep() 取商品处由：
//   const products = loadProducts();
// 改为：
//   const products = loadSweepProducts(loadProducts(), { log: logHermes });
// base 照旧、intake 去重追加、缺文件零影响、读错只 warning。batch cursor / records 合并均未改。
