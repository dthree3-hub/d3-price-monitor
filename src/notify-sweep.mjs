// notify-sweep.mjs — Hermes/D3 all 抓取+同步完成后的 Telegram 报告。
// 复用 recovery/TelegramNotifier(sendMessage, 读 .env TELEGRAM_BOT_TOKEN/CHAT_ID)。
// 4 段：① Price Changes(主) ② Sweep Summary ③ Cheaper Than Us ④ Failed Listings。
// 总开关 HERMES_NOTIFY_SWEEP=1(默认关)；只有显式 =1 才发(代码为 !== '1' 即跳过)。通知失败绝不影响 Hermes(全 try/catch)。
//
// CLI:
//   node src/notify-sweep.mjs --dry-run   # 用最近 records.json 造样本，只打印不发送
//   node src/notify-sweep.mjs --test      # 同上但真的发一条到 Telegram

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TelegramNotifier } from './recovery/TelegramNotifier.mjs';
import { readRecords, buildChangeReport } from './lib-records.mjs';

const TG_LIMIT = 4096;
const TOP_N = 15;
const TOP_CHANGES = 10;
const CHANGE_STATUSES = ['up', 'down', 'restocked', 'sold_out'];
const DEFAULT_VOUCHER_DISCOUNT = 5; // 与前端 DEFAULT_VOUCHER_DISCOUNT 一致(挂牌价=原价−RM5)

const SELF_SHOP = '54618012';
const COMP_SHOPS = ['116917349', '77792787', '271823454']; // A/B/C(Urban 56447030 已从看板移除)
const SELLER_NAME = {
  '54618012': 'Our Store', '116917349': 'Deal Direct',
  '77792787': 'Spray Gadget', '271823454': 'TAC Mobiles',
};

// ── 与前端完全一致的归一(保证 Cheaper 数量 ≈ Dashboard 🔥 N) ──
function normalizeModelKey(mk) {
  if (!mk) return null;
  let s = String(mk).replace(/\s+/g, ' ').trim();
  s = s.replace(/^S(1[01])\b/i, 'Tab S$1');
  s = s.replace(/^(A11\+?)\b/i, 'Tab $1');
  if (!/^Tab\b/i.test(s)) s = s.replace(/\bLTE\b/gi, '4G');
  s = s.replace(/\b(A(?:26|36|37|56|57))\s*5G\b/gi, '$1');
  s = s.replace(/\b(S2[3-6](?:\s*\+|\s*Ultra|\s*FE)?)\s*5G\b/gi, '$1');
  s = s.replace(/\bWi[\s-]?Fi\b/gi, '');
  return s.replace(/\s+/g, ' ').trim();
}
function capacityLabelOf(n) {
  const text = String(n || '').trim();
  const m = text.match(/(\d+)\+(\d+)(GB|TB)/i);
  if (m) return `${m[2]}${m[3].toUpperCase()}`;
  return text.replace(/\s+/g, '');
}
function mkOf(model, capacity) {
  return normalizeModelKey(`${model || ''}${capacity ? ` ${capacityLabelOf(capacity)}` : ''}`);
}
const afterVoucher = (v) => (v == null ? null : Math.max(0, Number((Number(v) - DEFAULT_VOUCHER_DISCOUNT).toFixed(2))));
const rm = (v) => (v == null || !Number.isFinite(Number(v)) ? '-' : `RM${Number(v).toFixed(2).replace(/\.00$/, '')}`);

// ── ③ Cheaper Than Us：每 mk 自家最低 vs 三家竞品最低(afterVoucher)；竞品更低则入列 ──
export function computeCheaperThanUs(records) {
  const self = {}; const comp = {}; // mk -> {price, role}
  for (const rec of records || []) {
    const sid = String(rec.shopId || '');
    const isSelf = sid === SELF_SHOP;
    const isComp = COMP_SHOPS.includes(sid);
    if (!isSelf && !isComp) continue;
    for (const v of rec.variants || []) {
      if (v.inStock === false) continue;            // 缺货不参与比价(与看板一致取在售最低)
      const price = afterVoucher(v.currentPrice);
      if (price == null) continue;
      const mk = mkOf(v.model, v.capacity);
      if (!mk) continue;
      if (isSelf) { if (!self[mk] || price < self[mk]) self[mk] = price; }
      else { if (!comp[mk] || price < comp[mk].price) comp[mk] = { price, role: SELLER_NAME[sid] || sid }; }
    }
  }
  const out = [];
  for (const mk of Object.keys(self)) {
    if (comp[mk] && comp[mk].price < self[mk]) {
      out.push({ mk, our: self[mk], comp: comp[mk].price, role: comp[mk].role, gap: Number((self[mk] - comp[mk].price).toFixed(2)) });
    }
  }
  out.sort((a, b) => b.gap - a.gap);
  return out;
}

// ── ① Price Changes(主 section)：本轮 vs 上一轮，价格不同就列(up/down)，Top 15 ──
export function buildPriceChangesSection(changes) {
  const priced = (changes || [])
    .filter((c) => (c.status === 'up' || c.status === 'down') && c.previousPrice != null && c.currentPrice != null)
    .sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  const lines = ['📈 Price Changes', ''];
  if (!priced.length) { lines.push('No price changes detected'); return lines.join('\n'); }
  priced.slice(0, TOP_N).forEach((c, i) => {
    const title = mkOf(c.model, c.capacity) || `${c.model || ''} ${capacityLabelOf(c.capacity)}`.trim();
    const sign = (c.delta || 0) < 0 ? '-' : '+';
    lines.push(
      `${i + 1}. ${title}`,
      `${c.sellerName || c.shopId} / ${c.tier || '-'}`,
      `${rm(c.previousPrice)} → ${rm(c.currentPrice)}`,
      `变化：${sign}${rm(Math.abs(c.delta || 0))}`,
      ''
    );
  });
  if (priced.length > TOP_N) lines.push(`+${priced.length - TOP_N} more`);
  return lines.join('\n').trimEnd();
}

// ── 对手变价(对比上一次抓到的价)：排除自家店，只留 up/down/restocked/sold_out；按 |变动额| 排序、去重显示行 ──
// 直接从 records 自带历史重算(latest vs previous)，绕开 runOnce 那个只比 incoming[0] 时间戳的 bug。
export function competitorChanges(records) {
  const raw = buildChangeReport(records || [])
    .filter((c) => String(c.sellerName || '').trim().toLowerCase() !== 'our store'
      && CHANGE_STATUSES.includes(c.status));
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    const key = `${c.sellerName}|${c.model}|${c.capacity}|${c.tier}|${c.status}|${c.previousPrice}|${c.currentPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
}

// ── ① 主 section：对手变价对比上次；没有变化就显示「没有变化」 ──
export function buildChangesSection(changes) {
  const lines = ['📊 Competitor Changes (vs last sweep)', ''];
  if (!changes || !changes.length) { lines.push('No changes'); return lines.join('\n'); }
  changes.slice(0, TOP_CHANGES).forEach((c, i) => {
    const title = mkOf(c.model, c.capacity) || `${c.model || ''}${c.capacity ? ` ${c.capacity}` : ''}`.trim() || '(unknown)';
    const who = `${c.sellerName || c.shopId}/${c.tier || '-'}`;
    let detail = '';
    if (c.status === 'up' || c.status === 'down') {
      const sign = (c.delta || 0) < 0 ? '-' : '+';
      detail = `${rm(c.previousPrice)}→${rm(c.currentPrice)} (${sign}${rm(Math.abs(c.delta || 0))})`;
    } else if (c.status === 'restocked') {
      detail = `restocked ${rm(c.currentPrice)}`;
    } else if (c.status === 'sold_out') {
      detail = `sold out (was ${rm(c.previousPrice)})`;
    }
    lines.push(`${i + 1}. ${title} · ${who} · ${detail}`);
  });
  if (changes.length > TOP_CHANGES) lines.push(`+${changes.length - TOP_CHANGES} more`);
  return lines.join('\n').trimEnd();
}

// YYYY-MM-DD HH:mm（吉隆坡时区）
function fmtKL(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(d));
  const g = (t) => parts.find((x) => x.type === t)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

// ── ② Sweep Summary ──
export function buildSummarySection({ scraped = 0, total = 0, failuresCount = 0, cloudSync = {}, completedAt = new Date() } = {}) {
  const sync = cloudSync && cloudSync.ok ? '✅' : '❌ ' + ((cloudSync && cloudSync.info) || 'not synced');
  return [
    '✅ Sweep Summary',
    `OK ${scraped}/${total} · Failed ${failuresCount} · Sync ${sync}`,
    `Completed: ${fmtKL(completedAt)}`,
  ].join('\n');
}

// ── ②b Final Status（仅当本轮真的 retry 过：retry.retried>0 才用这段替代 Summary）──
// 三段式：Original Sweep → Retry Failed → Final Status，再接 Failed Listings。
// 纯展示：全部数字来自已有字段，不改 runOnce / retry / hermes-status.json schema。
//   finalOK(a)     = scraped                     retry 后成功
//   total(y)       = total                       本轮选中 listing 总数
//   finalFailed(b) = failuresCount               retry 后最终失败
//   retried(n)     = retry.retried
//   recovered(m)   = retry.retrySuccess          retry 救回
//   stillFailed(k) = retry.retryFailed
//   originalOK(x)  = scraped - retrySuccess       (= a - m)
//   originalFail(z)= failuresCount + retrySuccess (= b + m，保证 z - m = b，与 Final 对账)
export function buildFinalStatusSection(data = {}) {
  const { scraped = 0, total = 0, failuresCount = 0, retry = {}, cloudSync = {}, completedAt = new Date() } = data;
  const { retried = 0, retrySuccess = 0, retryFailed = 0, skipped = 0 } = retry;
  const originalOK = scraped - retrySuccess;
  const originalFailed = failuresCount + retrySuccess;
  const sync = cloudSync && cloudSync.ok ? '✅' : '❌ ' + ((cloudSync && cloudSync.info) || 'not synced');
  return [
    '📊 Original Sweep',
    `OK ${originalOK}/${total}`,
    `Failed ${originalFailed}`,
    '',
    '🔁 Retry Failed',
    `Retried ${retried}`,
    `Recovered ${retrySuccess}`,
    `Still Failed ${retryFailed}`,
    `Skipped ${skipped}`,
    '',
    '📈 Final Status',
    `OK ${scraped}/${total}`,
    `Failed ${failuresCount}`,
    '',
    `Sync ${sync} · Completed: ${fmtKL(completedAt)}`,
  ].join('\n');
}

// ── ③ Cheaper section(辅助) ──
export function buildCheaperSection(cheaper) {
  const lines = ['🔥 Cheaper Than Us', ''];
  if (!cheaper || !cheaper.length) { lines.push('None 🎉'); return lines.join('\n'); }
  lines.push(`${cheaper.length} model(s) where a competitor is cheaper:`, '');
  cheaper.slice(0, TOP_N).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.mk}`, `Our ${rm(c.our)} · ${c.role} ${rm(c.comp)} · Gap -${rm(c.gap)}`, '');
  });
  if (cheaper.length > TOP_N) lines.push(`+${cheaper.length - TOP_N} more`);
  return lines.join('\n').trimEnd();
}

// ── 🔄 Retry Summary（反爬失败重跑一次的统计）──
export function buildRetrySection(retry = {}) {
  const { antiBotFailures = 0, retried = 0, retrySuccess = 0, retryFailed = 0, skipped = 0 } = retry;
  const lines = [
    '🔄 Retry Summary',
    '',
    `Anti-bot failures: ${antiBotFailures}`,
    `Retried: ${retried}`,
    `Retry success: ${retrySuccess}`,
    `Retry failed: ${retryFailed}`,
  ];
  if (skipped > 0) {
    lines.push('', '⚠️ Retry limit reached', `Retried: ${retried}`, `Skipped: ${skipped}`);
  }
  return lines.join('\n');
}

// ── ④ Failed Listings ──
// 格式：[Seller] | [Model] | [Reason]，一行一条。绝不放完整 Shopee URL（太长，刷屏）——
// URL 仍保留在日志/报告文件里(out/*.md)，只是不进 Telegram。
// 失败项历史上是字符串「seller | url | error」，也可能是结构化对象；两种都解析。

const RX_SHOP_ITEM = /i\.(\d+)\.(\d+)/; // 从 Shopee URL 抠 shopId.itemId
const _projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // src/.. = 仓库根

// itemId → 干净型号名：复用 Dashboard 那份 itemmap(d3-price/index.html 里的 D3_ITEM_MODEL)，
// 它是 itemId→"Tab S11 Ultra"/"S26 Ultra" 这种干净名(products.csv 的 our_product 是长标题，不用)。
// 懒加载+缓存+容错；读不到就退回 URL 兜底。
let _itemModel = null;
function itemModelMap() {
  if (_itemModel) return _itemModel;
  _itemModel = new Map();
  try {
    const html = fs.readFileSync(path.join(_projectRoot, 'd3-price', 'index.html'), 'utf8');
    const m = html.match(/window\.D3_ITEM_MODEL\s*=\s*(\{.*?\})\s*;/s);
    if (m) { const obj = JSON.parse(m[1]); for (const k of Object.keys(obj)) _itemModel.set(k, String(obj[k]).trim()); }
  } catch { /* 无 index.html / 解析失败 → URL 兜底 */ }
  return _itemModel;
}

// 中文/技术错误 → 简短英文(规则 5)。命中不了就截断原文，绝不外泄长串。
function friendlyReason(raw) {
  const s = String(raw || '').trim();
  if (/页面加载超时|page\s*load\s*timeout|加载超时|timeout|timed out.*\d+ms|超时\s*\d+ms/i.test(s)
      && !/verification|验证/i.test(s)) return 'Page Load Timeout';
  if (/verification|验证/i.test(s)) return 'Verification Timeout';
  if (/page\s*unavailable|页面不可用|unavailable/i.test(s)) return 'Page Unavailable';
  if (/404|商品下架|下架|removed|not\s*found/i.test(s)) return 'Product Removed';
  return s ? (s.length > 36 ? s.slice(0, 36) + '…' : s) : 'Failed';
}

// our_product 缺失时，从 URL slug 抠一个短名（剥掉 Samsung/Galaxy/营销词），最多取几个词。
function shortNameFromUrl(url) {
  const m = String(url || '').match(/shopee\.com\.my\/(.+?)-i\.\d+\.\d+/i);
  if (!m) return '';
  let s = decodeURIComponent(m[1]).replace(/%[0-9a-f]{2}/gi, ' ').replace(/[-_]+/g, ' ');
  s = s.replace(/\(.*?\)/g, ' ')
       .replace(/\b(Samsung|Galaxy|Malaysia|Warranty|Original|Ready\s*Stock|NEW|PROMO|Set|Smartphone)\b/gi, ' ')
       .replace(/[^\w+/.\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').slice(0, 5).join(' ');
}

// 去掉「Samsung Galaxy」前缀，跟示例的简短风格一致。
function trimModel(name) {
  return String(name || '').replace(/^\s*Samsung\s+(Galaxy\s+)?/i, '').trim();
}

// 失败项 → {seller, model, reason}。兼容 string("seller | url | error") 与 object。
// 型号优先用 itemmap(itemId→干净名)；拿不到再从 URL slug 兜底(规则 3/4)。
function parseFailure(f) {
  if (typeof f === 'string') {
    const parts = f.split('|').map((x) => x.trim());
    const seller = parts[0] || '-';
    const url = parts[1] || '';
    const m = url.match(RX_SHOP_ITEM);
    const model = trimModel((m && itemModelMap().get(m[2])) || shortNameFromUrl(url)) || 'Unknown Model';
    return { seller, model, reason: friendlyReason(parts.slice(2).join(' | ')) };
  }
  const seller = f.competitor || SELLER_NAME[f.shopId] || f.shopId || '-';
  const url = f.product?.product_url || f.productUrl || '';
  const itemId = f.itemId || (url.match(RX_SHOP_ITEM) || [])[2];
  const model = trimModel((itemId && itemModelMap().get(String(itemId))) || f.model || shortNameFromUrl(url)) || 'Unknown Model';
  return { seller, model, reason: friendlyReason(f.reason) };
}

export function buildFailedSection(failures) {
  const lines = ['❌ Failed Listings', ''];
  if (!failures || !failures.length) { lines.push('None'); return lines.join('\n'); }
  failures.slice(0, TOP_N).forEach((f, i) => {
    const { seller, model, reason } = parseFailure(f);
    lines.push(`${i + 1}. ${seller} | ${model} | ${reason}`);
  });
  if (failures.length > TOP_N) lines.push(`+${failures.length - TOP_N} more`);
  return lines.join('\n');
}

// 组装：对手变价(主) + (Summary+Failed)。从 data.records 重算变价(忽略 data.changes，绕开旧 bug)。
// 合并若 ≤4096 一条；否则拆两条(变价段永不被挤掉)。不再含 Cheaper Than Us / Retry。
export function buildReports(data) {
  const changesMsg = buildChangesSection(competitorChanges(data.records || []));
  // 本轮真的 retry 过(retried>0) → 三段式 Final Status；否则保持紧凑 Sweep Summary。
  const summaryMsg = data.retry && data.retry.retried > 0
    ? buildFinalStatusSection(data)
    : buildSummarySection(data);
  const restMsg = [
    summaryMsg,
    buildFailedSection(data.failures),
  ].join('\n\n———\n\n');
  const combined = `${changesMsg}\n\n———\n\n${restMsg}`;
  return combined.length <= TG_LIMIT ? [combined] : [changesMsg, restMsg];
}

// 发送(生产)：开关 + try/catch；任何异常只 log、不冒泡。
export async function sendSweepReport(data, { dryRun = false, log = () => {} } = {}) {
  const messages = buildReports(data);
  if (dryRun) return { messages, sent: false };
  if (process.env.HERMES_NOTIFY_SWEEP !== '1') { log('[notify] HERMES_NOTIFY_SWEEP!=1，跳过 sweep 报告'); return { messages, sent: false }; }
  try {
    const tg = new TelegramNotifier();
    if (!tg.enabled) { log('[notify] 无 TELEGRAM_BOT_TOKEN/CHAT_ID，跳过'); return { messages, sent: false }; }
    for (const m of messages) { try { await tg.sendMessage(m); } catch (e) { log(`[notify] 发送失败(忽略): ${e.message || e}`); } }
    return { messages, sent: true };
  } catch (e) {
    log(`[notify] 异常(忽略): ${e.message || e}`);
    return { messages, sent: false };
  }
}

// ── CLI: --dry-run / --test（用最近 records.json + 样本 changes/failures 演示格式）──
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = process.argv.includes('--test');
  const records = (() => { try { return readRecords(); } catch { return []; } })();
  const sampleChanges = [
    { status: 'down', model: 'A57', capacity: '12+256GB', tier: 'Basic', sellerName: 'Deal Direct', shopId: '116917349', previousPrice: 1739, currentPrice: 1729, delta: -10 },
    { status: 'down', model: 'Tab S10 FE', capacity: '256GB', tier: 'Promo', sellerName: 'Spray Gadget', shopId: '77792787', previousPrice: 2694, currentPrice: 2599, delta: -95 },
    { status: 'up', model: 'S25 Ultra', capacity: '12+256GB', tier: 'Basic', sellerName: 'TAC Mobiles', shopId: '271823454', previousPrice: 4299, currentPrice: 4399, delta: 100 },
  ];
  // 真实失败项是「seller | url | error」字符串(runOnce 当前就这么 push)；演示用真实 itemId 让 itemmap 反查生效。
  const sampleFailures = [
    'Spray Gadget | https://shopee.com.my/X-i.77792787.41519990686?x=1 | 页面加载超时 20000ms',
    'Deal Direct | https://shopee.com.my/X-i.116917349.20650403967?x=1 | 页面加载超时 20000ms',
    'TAC Mobiles | https://shopee.com.my/X-i.271823454.43228940960?x=1 | 页面加载超时 20000ms',
    'Deal Direct | https://shopee.com.my/X-i.116917349.26905026841?x=1 | verification wait timed out',
    'TAC Mobiles | https://shopee.com.my/X-i.271823454.8133737389?x=1 | 404 商品下架',
  ];
  const sampleRetry = { antiBotFailures: 17, retried: 10, retrySuccess: 8, retryFailed: 2, skipped: 7 };
  sendSweepReport({
    records, changes: sampleChanges, failures: sampleFailures, retry: sampleRetry,
    scraped: 96, total: 106, failuresCount: sampleFailures.length,
    cloudSync: { ok: true, info: '76 条' }, completedAt: new Date(),
  }, { dryRun: !test, log: console.error }).then((r) => {
    console.log(`\n==== ${test ? 'TEST SEND' : 'DRY-RUN'}: ${r.messages.length} 条消息${r.sent ? '(已发送)' : ''} ====\n`);
    r.messages.forEach((m, i) => { console.log(`---------- 消息 ${i + 1} (${m.length} 字符) ----------`); console.log(m); console.log(); });
  });
}
