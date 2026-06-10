// csp-source.mjs — 从 Google Sheet 读 CSP(成本价),建 Model→CSP 映射,带本地缓存。
//   - 读 `Samsung!A:B`(A=型号, B=CSP)
//   - 缓存到 out/csp-cache.json,默认 6 小时 TTL(避免每轮都打 Google)
//   - 拉取失败时回退到上次缓存,不拖垮主流程
//
// 环境变量:
//   GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON  见 google-sheets.mjs
//   HERMES_CSP_TAB     默认 'Samsung'
//   HERMES_CSP_TTL_MS  默认 21600000(6 小时)

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './lib-records.mjs';
import { readSheetRange } from './google-sheets.mjs';

const cacheFile = path.join(projectRoot, 'out', 'csp-cache.json');
const CSP_TAB = process.env.HERMES_CSP_TAB || 'Samsung';
const TTL_MS = Number(process.env.HERMES_CSP_TTL_MS || 6 * 3600 * 1000);

// "RM 382" / "382.0" / "382" → 382;空/非数 → null
function toCsp(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 直接从 Sheet 拉一次,返回 { [model]: csp }。跳过表头/空行。
export async function fetchCspMap() {
  const rows = await readSheetRange(`${CSP_TAB}!A:B`);
  const map = {};
  for (const row of rows) {
    const model = String(row?.[0] ?? '').trim();
    const csp = toCsp(row?.[1]);
    // 跳过表头(B 列不是数字)和空行
    if (model && csp != null && !/^csp$/i.test(model)) map[model] = csp;
  }
  return map;
}

export async function refreshCspCache() {
  const csp = await fetchCspMap();
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    tab: CSP_TAB,
    count: Object.keys(csp).length,
    csp,
  }, null, 2)}\n`);
  return csp;
}

export function readCspCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null;
  }
}

// 主入口:缓存新鲜就用缓存,过期就刷新;刷新失败回退旧缓存。
export async function getCspMap({ force = false } = {}) {
  const cached = readCspCache();
  const fresh = cached && (Date.now() - new Date(cached.updatedAt).getTime() < TTL_MS);
  if (!force && fresh) return cached.csp;
  try {
    return await refreshCspCache();
  } catch (error) {
    if (cached) return cached.csp; // 拉取失败用旧的,不中断
    throw error;
  }
}

// 命令行自测:node src/csp-source.mjs  →  打印读到多少条 + 前几条
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnvFile } = await import('./lib-hermes.mjs');
  loadEnvFile();
  refreshCspCache()
    .then((csp) => {
      const keys = Object.keys(csp);
      console.log(`✅ 读到 ${keys.length} 条 CSP(tab=${CSP_TAB})`);
      for (const k of keys.slice(0, 8)) console.log(`  ${k} = ${csp[k]}`);
      console.log(`缓存已写: out/csp-cache.json`);
    })
    .catch((e) => {
      console.error('❌ 读取失败:', e.message);
      process.exit(1);
    });
}
