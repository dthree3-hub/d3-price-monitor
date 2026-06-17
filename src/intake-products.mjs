// Product Intake — Hermes 接入接口（Phase 1：inert，未接入 sweep）。
//
// 背景：网页「Product Intake」页面手动新增要监控的新商品（存浏览器 localStorage），
// 通过页面上的「Export Active (Hermes products.csv)」按钮导出成一个与 config/products.csv
// 同表头的 CSV（默认文件名 product-intake.csv）。把它放到 Hermes 机器的 config/ 下，
// 本模块即可把里面 status=active 的商品读成与 loadProducts() 同形状的行对象。
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
  const useHeader = header.includes('product_url') ? header : INTAKE_CSV_HEADER;
  const body = header.includes('product_url') ? rows.slice(1) : rows;
  return body
    .filter((row) => row.some((cell) => String(cell || '').trim()))
    .map((row) => Object.fromEntries(useHeader.map((key, idx) => [key, String(row[idx] || '').trim()])))
    .filter((row) => row.product_url && (!row.status || row.status.toLowerCase() === 'active'));
}

// Hermes 侧入口：读 intake CSV（默认 config/product-intake.csv），返回可直接 append 到
// loadProducts() 结果的行数组。文件不存在/读失败 → 返回 []（绝不抛，避免影响整轮 sweep）。
export function loadIntakeProducts(csvPath) {
  const file = csvPath || path.join(process.cwd(), 'config', 'product-intake.csv');
  try {
    if (!fs.existsSync(file)) return [];
    return intakeRowsFromCsv(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// ── Phase 2 接入示例（现在不要启用）──────────────────────────────
// 在 sweep 取商品列表处改为合并，新商品只是 append、失败只记录不阻断：
//
//   import { loadProducts } from './lib-hermes.mjs';
//   import { loadIntakeProducts } from './intake-products.mjs';
//   const products = [...loadProducts(), ...loadIntakeProducts()];
//
// 现有 sweep 逻辑、batch cursor、records 合并均不需改动。
