// Telegram 价格查询：数字全部来自 Worker /api/records（与 Dashboard 同一份 D1 数据）。
// 不让 AI 猜价；找不到就明确说找不到。回复固定英文。
import { loadProducts, parseProductUrlIds, logHermes } from './lib-hermes.mjs';

// Worker 读接口（由 .env 的 D3_CLOUD_RECORDS_URL 推导 base；可用 D3_RECORDS_API_URL 覆盖）
const RECORDS_URL = process.env.D3_RECORDS_API_URL
  || `${(process.env.D3_CLOUD_RECORDS_URL || '').replace(/\/api\/.*$/, '') || 'https://d3-price-worker.dthree.workers.dev'}/api/records`;
// Take Back ← Google Sheet H 列「Take back (S)」，与 Dashboard 同一个 /api/csp 接口
const CSP_URL = RECORDS_URL.replace(/\/api\/records.*$/, '/api/csp');

const OUR_SHOP_FALLBACK = '54618012'; // 自家 D3 店（products.csv competitor=Our Store）
const SHOP_NAME_FALLBACK = { '77792787': 'Spray Gadget', '116917349': 'Deal Direct', '271823454': 'TAC Mobiles' };
const DUMMY_PRICE = 999; // RM999 占位组合，排除
const RECORDS_TTL_MS = 60_000;

let cache = { at: 0, records: null };
let cspCache = { at: 0, map: null };

async function fetchRecords() {
  if (cache.records && Date.now() - cache.at < RECORDS_TTL_MS) return cache.records;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(RECORDS_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`records HTTP ${res.status}`);
    const data = await res.json();
    const records = Array.isArray(data.records) ? data.records : [];
    cache = { at: Date.now(), records };
    return records;
  } finally {
    clearTimeout(timer);
  }
}

// 复刻 Dashboard d3-price/index.html normalizeModelKey（必须与网页逐字一致，
// 否则 Take Back 键匹配不上）。两边都过同一函数 → 同口径。
function normalizeModelKey(mk) {
  if (!mk) return null;
  let s = String(mk).replace(/\s+/g, ' ').trim();
  s = s.replace(/^S(1[01])\b/i, 'Tab S$1');
  s = s.replace(/^(A11\+?)\b/i, 'Tab $1');
  if (!/^Tab\b/i.test(s) && !/^Watch\b/i.test(s)) s = s.replace(/\bLTE\b/gi, '4G');
  if (/^Tab A11\+?\b/i.test(s) && !/\bWi[\s-]?Fi\b/i.test(s)) {
    s = s.replace(/\b(?:LTE\s+)?4G\b/gi, 'LTE');
    s = s.replace(/\bLTE(?:\s+LTE)+\b/gi, 'LTE');
  }
  s = s.replace(/\b(A(?:26|36|37|56|57))\s*5G\b/gi, '$1');
  s = s.replace(/\b(S2[3-6](?:\s*\+|\s*Ultra|\s*FE)?)\s*5G\b/gi, '$1');
  if (!/^Tab A11\+?\b/i.test(s)) s = s.replace(/\bWi[\s-]?Fi\b/gi, '');
  return s.replace(/\s+/g, ' ').trim();
}

// 复刻 Dashboard capacityLabelOf：型号配对只看存储、忽略 RAM（6+128GB → 128GB）
function capacityLabelOf(n) {
  const text = String(n || '').trim();
  const m = text.match(/(\d+)\+(\d+)(GB|TB)/i);
  if (m) return `${m[2]}${m[3].toUpperCase()}`;
  return text.replace(/\s+/g, '');
}

// 取 Google Sheet Take back(S) 值（同一 /api/csp，缓存 60s；失败保留上次值）
async function fetchCsp() {
  if (cspCache.map && Date.now() - cspCache.at < RECORDS_TTL_MS) return cspCache.map;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(CSP_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`csp HTTP ${res.status}`);
    const data = await res.json();
    const rows = data && data.rows && typeof data.rows === 'object' ? data.rows : {};
    const map = {};
    for (const [rawKey, tb] of Object.entries(rows)) {
      if (tb == null || tb === '') continue;
      map[normalizeModelKey(rawKey).toLowerCase()] = tb; // 与 Dashboard 一致
    }
    cspCache = { at: Date.now(), map };
    return map;
  } catch (error) {
    logHermes(`Take Back 取 /api/csp 失败（保留上次值）：${error.message || String(error)}`);
    return cspCache.map || {}; // 失败不清空，沿用上次
  } finally {
    clearTimeout(timer);
  }
}

// 某型号的 Take Back(S) 值，找不到返回 null（→ 显示 "—"）
function takeBackOf(cspMap, model, capacity) {
  if (!cspMap) return null;
  const key = normalizeModelKey(`${model} ${capacityLabelOf(capacity)}`);
  if (!key) return null;
  const v = cspMap[key.toLowerCase()];
  return v == null ? null : v;
}

function fmtTakeBack(v) {
  return v == null ? '—' : `RM${fmtMoney(v)}`;
}

// 价格竞争一句话（已去掉 take back 动作字样，统一叫 Pricing Status）
function pricingStatus(our, compName, compPrice) {
  if (our == null) return 'Not listed in our store';
  if (compName == null || compPrice == null) return 'No competitor stocks this right now';
  const diff = compPrice - our; // >0 我们更便宜
  if (diff > 0.005) return `We are RM${fmtMoney(diff)} cheaper than ${compName}`;
  if (diff < -0.005) return `RM${fmtMoney(-diff)} higher than ${compName}`;
  return `Same price as ${compName}`;
}

// 从 products.csv 建 shopId → {是否自家, 竞品名}
function buildShopMap() {
  const ours = new Set([OUR_SHOP_FALLBACK]);
  const names = {};
  try {
    for (const p of loadProducts()) {
      const ids = parseProductUrlIds(p.product_url);
      if (!ids) continue;
      const shopId = String(ids.shopId);
      const comp = String(p.competitor || '').trim();
      if (/^our\s*store$/i.test(comp)) ours.add(shopId);
      else if (comp) names[shopId] = comp;
    }
  } catch (error) {
    logHermes(`价格查询：读取 products.csv 失败（用 fallback）：${error.message || String(error)}`);
  }
  return { ours, names };
}

function fmtMoney(n) {
  const x = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

// 把自然语言查询拆成大写 token；归一化 12+256GB→256GB、256 GB→256GB；去掉停用词
function queryTokens(text) {
  let t = ` ${String(text || '').toUpperCase()} `;
  // 仅当 RAM+存储无空格相连(如 12+256GB)才归一化为存储，避免误伤型号里的 "+"(如 S26+ 256GB)
  t = t.replace(/(\d+)\+(\d+)\s*(GB|TB)/g, ' $2$3 ');
  t = t.replace(/(\d+)\s*(GB|TB)/g, ' $1$2 ');
  t = t.replace(/\+/g, ' PLUS '); // 剩下的 "+"(型号 Plus，如 S26+)统一成 PLUS token，与变体侧对齐
  const stop = new Set([
    'WHAT', 'IS', 'THE', 'PRICE', 'PRICES', 'OF', 'HOW', 'MUCH', 'FOR', 'ME', 'TELL',
    'CURRENT', 'PLEASE', 'GIVE', 'SHOW', 'D3', 'SHOPEE', 'SAMSUNG', 'GALAXY', 'RM',
    'COST', 'BERAPA', 'HARGA', 'NOW', 'YOUR', 'OUR',
    // Intent Layer 指令词：take back / series / what-if，剔除后型号匹配才干净
    'TAKE', 'BACK', 'TAKEBACK', 'AND', 'NEED', 'NEEDS', 'NEEDED', 'SERIES', 'ALL', 'EVERYTHING', 'UNDERCUT',
    'CHEAPER', 'CHEAPEST', 'THAN', 'US', 'WE', 'LOWER', 'REDUCE', 'REDUCTION', 'CUT', 'DROP',
    'IF', 'BY', 'TO', 'WOULD', 'HAPPEN', 'AFTER', 'MODEL', 'MODELS', 'WHICH', 'WHO', 'WHOSE',
    'CHECK', 'STILL', 'BEAT', 'BEATS',
    // 知识问句词（避免污染型号匹配；这些句子本应被知识护栏路由到 AI）
    'FORMULA', 'CALCULATION', 'CALCULATE', 'CALCULATED', 'CALCULATES', 'EXPLAIN', 'MEAN', 'MEANS',
    'MEANING', 'WHY', 'DOES', 'DO', 'ARE', 'DEFINE', 'DEFINITION', 'WORK', 'WORKS',
  ]);
  return ` ${t} `
    .replace(/[^A-Z0-9]/g, ' ') // 此时 "+" 已转 PLUS，无需保留
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
}

function variantTokens(v) {
  return new Set(
    `${v.model || ''} ${v.capacity || ''}`
      .toUpperCase()
      .replace(/\+/g, ' PLUS ') // S26+ → S26 PLUS，与 queryTokens 对齐，便于型号限定词精确比较
      .replace(/[^A-Z0-9]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

// 区分标准/Plus/Ultra/FE 的型号限定词；必须与查询双向一致，标准版 S26 不被 S26+/S26 Ultra 混入
const MODEL_QUALIFIERS = ['ULTRA', 'FE', 'PLUS'];

function matchVariants(records, tokens) {
  const out = [];
  const queryQuals = new Set(tokens.filter((t) => MODEL_QUALIFIERS.includes(t)));
  for (const r of records) {
    for (const v of r.variants || []) {
      if (v.inStock === false || v.soldOut === true) continue;
      const price = Number(v.currentPrice);
      if (!Number.isFinite(price) || price === DUMMY_PRICE) continue;
      const vt = variantTokens(v);
      // 子集匹配保证查询 token(含网络 4G/5G——用户指定才限制)都在变体里
      if (!tokens.every((tok) => vt.has(tok))) continue;
      // 型号限定词须双向一致：变体含 query 未指定的 Ultra/Plus/FE 则排除
      if (MODEL_QUALIFIERS.some((q) => vt.has(q) && !queryQuals.has(q))) continue;
      out.push({ shopId: String(r.shopId), model: v.model, capacity: v.capacity, tier: v.tier, price });
    }
  }
  return out;
}

const TIER_ORDER = ['A', 'B', 'Basic', 'Promo'];
const TIER_LABEL = { A: 'Set A', B: 'Set B', Basic: 'Basic', Promo: 'Promo' };

function renderReport(comboName, items, shopMap) {
  const ours = items.filter((i) => shopMap.ours.has(i.shopId));
  const comps = items.filter((i) => !shopMap.ours.has(i.shopId));
  const lines = [comboName, '', 'D3:'];

  // 自家：每个档位取最低价，列全档
  const byTier = new Map();
  for (const i of ours) {
    const cur = byTier.get(i.tier);
    if (cur == null || i.price < cur) byTier.set(i.tier, i.price);
  }
  let d3Lowest = null;
  if (byTier.size === 0) {
    lines.push('- not listed in our store');
  } else {
    const tiers = [...byTier.keys()].sort(
      (a, b) => (TIER_ORDER.indexOf(a) + 1 || 99) - (TIER_ORDER.indexOf(b) + 1 || 99)
    );
    for (const t of tiers) {
      const p = byTier.get(t);
      lines.push(`- ${TIER_LABEL[t] || t}: RM${fmtMoney(p)}`);
      d3Lowest = d3Lowest == null ? p : Math.min(d3Lowest, p);
    }
    lines.push(`(lowest: RM${fmtMoney(d3Lowest)})`);
  }

  // 竞品：每店最低价
  const byShop = new Map();
  for (const i of comps) {
    const cur = byShop.get(i.shopId);
    if (cur == null || i.price < cur) byShop.set(i.shopId, i.price);
  }
  lines.push('', 'Competitors (lowest):');
  if (byShop.size === 0) {
    lines.push('- none stock this model right now');
    return lines.join('\n');
  }
  const rows = [...byShop.entries()]
    .map(([sid, p]) => ({ name: shopMap.names[sid] || SHOP_NAME_FALLBACK[sid] || `Shop ${sid}`, price: p }))
    .sort((a, b) => a.price - b.price);
  for (const r of rows) lines.push(`- ${r.name}: RM${fmtMoney(r.price)}`);

  if (d3Lowest == null) return lines.join('\n');

  lines.push('', `Difference (vs D3 lowest RM${fmtMoney(d3Lowest)}):`);
  for (const r of rows) {
    const diff = r.price - d3Lowest;
    if (Math.abs(diff) < 0.005) lines.push(`- ${r.name}: same as D3`);
    else if (diff > 0) lines.push(`- ${r.name}: RM${fmtMoney(diff)} higher than D3`);
    else lines.push(`- ${r.name}: RM${fmtMoney(-diff)} lower than D3`);
  }

  const compMin = Math.min(...rows.map((r) => r.price));
  if (d3Lowest <= compMin) lines.push('', '→ D3 is cheapest on this model.');
  else lines.push('', `→ ${rows[0].name} is cheaper than D3 by RM${fmtMoney(d3Lowest - rows[0].price)}.`);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Take Back / What-If / Series 分析
// 口径照搬 Dashboard d3-price/index.html 的 build()/bossRender()/canonTier（gaps），
// 避免网页和 Telegram 算出来不一样：
//   · 价格 = raw currentPrice（用 /api/records 原值；diff 里 voucher 会抵消，与网页一致）
//   · 只统计 Promo / Basic / SET A 档（canonTier），排除 Set B / Gift Set / Demo / 空档
//   · D3 lowest = 自家店各变体最低；competitor lowest = 三家(A/B/C)各自最低里的最小
//   · 排除 Urban Republic(56447030)，与网页 activeRoles=['A','B','C'] 一致
//   · Pricing Status = competitor lowest vs D3 lowest（仅信息，不是降价动作）；list 只列被压价型号
//   · Take Back = Google Sheet H 列 Take back(S)，走同一 /api/csp + 同一 normalizeModelKey（与 Dashboard 一致），找不到显示 "—"
//   · 数字全部来自 /api/records 与 /api/csp，不让 AI 猜。不动 Worker / D1 / Dashboard。
// 已知差异（无法消除）：网页的 D3 lowest 可被老板在浏览器 localStorage 手动覆盖(ourPrices)，
//   Telegram 后端拿不到 → 这里只用 self 店实抓最低。若老板手动改过价，两边可能不同。
// ════════════════════════════════════════════════════════════════════════════

const URBAN_REPUBLIC_SHOP = '56447030'; // Dashboard activeRoles 不含 D，take back 也排除

const COMPETITOR_ALIASES = [
  { name: 'Deal Direct', re: /deal\s*direct/i },
  { name: 'Spray Gadget', re: /spray\s*gadget/i },
  { name: 'TAC Mobiles', re: /\btac\b(?:\s*mobiles?)?/i },
];

// 照搬 index.html canonTier（rawTierText 主用 v.tier）。返回 null = 不计入该档。
function canonTier(tier) {
  const raw = String(tier || '').trim();
  const t = raw.toLowerCase();
  if (!t) return null;
  if (t.includes('gift set')) return null;
  if (t.includes('demo')) return null;
  if (t.includes('promo')) return 'Promo';
  if (t.includes('basic')) return 'Basic';
  if (t.includes('set a') || t === 'a') return 'SET A';
  if (/^[abc]\s*\//.test(raw)) return 'Basic';
  if (/\/\s*standard\b/i.test(raw)) return 'Basic';
  if (/\d+\s*gb|\d+\s*\+\s*\d+|\d+\s*tb/i.test(t)) return 'Basic';
  return null;
}

// 从型号串抽系列基（S26 / A17 / FOLD ...）；S26+/S26 Ultra 都归到 S26
function seriesTokenOf(text) {
  const toks = String(text || '').toUpperCase().replace(/\+/g, ' PLUS ').replace(/[^A-Z0-9]/g, ' ').split(/\s+/).filter(Boolean);
  for (const t of toks) if (/^[AS]\d{1,2}$/.test(t)) return t;
  for (const t of toks) if (/^(FOLD|FLIP|TAB|TABS)\d*$/.test(t)) return t;
  return '';
}

// 把 records 聚合成 per「model + capacity」组合：自家最低 + 各竞品最低
function buildCombos(records, shopMap) {
  const combos = new Map();
  for (const r of records) {
    const shopId = String(r.shopId);
    if (shopId === URBAN_REPUBLIC_SHOP) continue;
    const isOurs = shopMap.ours.has(shopId);
    for (const v of r.variants || []) {
      if (v.inStock === false || v.soldOut === true) continue;
      const price = Number(v.currentPrice);
      if (!Number.isFinite(price) || price === DUMMY_PRICE) continue;
      if (!canonTier(v.tier)) continue; // 照搬网页档位过滤
      const model = String(v.model || '').trim();
      const capacity = String(v.capacity || '').trim();
      if (!model || !capacity) continue;
      const key = `${model} ${capacity}`;
      let c = combos.get(key);
      if (!c) { c = { model, capacity, our: null, comps: new Map() }; combos.set(key, c); }
      if (isOurs) {
        c.our = c.our == null ? price : Math.min(c.our, price);
      } else {
        const name = shopMap.names[shopId] || SHOP_NAME_FALLBACK[shopId] || `Shop ${shopId}`;
        const cur = c.comps.get(name);
        if (cur == null || price < cur) c.comps.set(name, price);
      }
    }
  }
  return combos;
}

// 把一个组合摊平成一行；onlyComp 指定时只看那家竞品，否则取全竞品最低
function comboRow(c, onlyComp) {
  let best = null;
  if (onlyComp) {
    for (const [name, price] of c.comps) {
      const ln = name.toLowerCase();
      const lc = onlyComp.toLowerCase();
      if (ln.includes(lc) || lc.includes(ln)) { best = { name, price }; break; }
    }
  } else {
    for (const [name, price] of c.comps) if (best == null || price < best.price) best = { name, price };
  }
  return {
    key: `${c.model} ${c.capacity}`,
    model: c.model,
    capacity: c.capacity,
    our: c.our,
    compName: best ? best.name : null,
    compPrice: best ? best.price : null,
    diff: (best && c.our != null) ? best.price - c.our : null, // <0 = 竞品更便宜
  };
}

// 单型号精确匹配（复用 matchVariants 的型号限定词规则：S26 不混入 S26+/Ultra）
function comboMatchesTokens(c, tokens) {
  const vt = variantTokens({ model: c.model, capacity: c.capacity });
  const queryQuals = new Set(tokens.filter((t) => MODEL_QUALIFIERS.includes(t)));
  if (!tokens.every((tok) => vt.has(tok))) return false;
  if (MODEL_QUALIFIERS.some((q) => vt.has(q) && !queryQuals.has(q))) return false;
  return true;
}

function detectCompetitor(text) {
  for (const c of COMPETITOR_ALIASES) if (c.re.test(text)) return c.name;
  return null;
}

function stripCompetitorNames(text) {
  let t = String(text || '');
  for (const c of COMPETITOR_ALIASES) t = t.replace(c.re, ' ');
  return t;
}

// 解析范围：single（型号+容量）/ series（系列）/ all
function parseScope(text) {
  const tokens = queryTokens(text);
  const hasStorage = tokens.some((t) => /^\d+(GB|TB)$/.test(t));
  const nonStorage = tokens.filter((t) => !/^\d+(GB|TB)$/.test(t));
  const base = seriesTokenOf(tokens.join(' ')); // 只认 [AS]\d / Fold / Flip / Tab
  const wantsSeries = /series|系列/i.test(text);
  // 显式 "X series" → 整系列
  if (wantsSeries && base) {
    return { kind: 'series', base, label: `${base} series` };
  }
  // 有容量 + 型号 token → 单一型号+容量
  if (hasStorage && nonStorage.length > 0) {
    return { kind: 'single', tokens, label: tokens.join(' ') };
  }
  // 无容量但有型号 token（含限定词 plus/FE/ultra）→ model scope，保留限定词、列该型号各容量（P2）
  if (base && nonStorage.length > 0) {
    return { kind: 'model', tokens, label: tokens.join(' ') };
  }
  return { kind: 'all', label: 'all models' };
}

function selectRows(combos, scope, onlyComp) {
  const rows = [...combos.values()].map((c) => comboRow(c, onlyComp));
  if (scope.kind === 'all') return rows;
  if (scope.kind === 'series') return rows.filter((r) => seriesTokenOf(r.model) === scope.base);
  return rows.filter((r) => comboMatchesTokens(combos.get(r.key), scope.tokens));
}

const sortByKey = (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true });

// 解析降价金额（RM 前缀或 lower/降 等关键词后跟数字；避开型号里的 S26 的 26）
function parseReduction(text) {
  const t = String(text || '');
  const m = t.match(/(?:lower|reduce|cut|drop|降价?|减价?|降|减)\s*(?:by\s*)?(?:to\s*)?(?:rm\s*)?(\d+(?:\.\d+)?)/i)
    || t.match(/\brm\s*(\d+(?:\.\d+)?)/i);
  return { amount: m ? Number(m[1]) : null };
}

// ── Intent 识别 ──────────────────────────────────────────────────────────────
function isWhatIfQuery(text) {
  const t = String(text || '');
  if (parseReduction(t).amount == null) return false;
  const reduceKw = /\blower\b|\breduce\b|\bcut\b|\bdrop\b|after reduction|降价|降\s*rm|降\s*\d|减价|减\s*\d|降到/i.test(t);
  const condKw = /\bif\b|如果|要是|假如/i.test(t) && /lower|reduce|cut|drop|降|减/i.test(t);
  return reduceKw || condKw;
}

function isTakeBackQuery(text) {
  return /take\s*back|怎样拿回|拿回第一|谁压我们|谁低过我们|压我们|cheaper than us|undercut|要降多少|需要降多少|哪些.*(take\s*back|调价|降价|要降)|哪些型号|需要take\s*back/i.test(String(text || ''));
}

function isSeriesQuery(text) {
  if (!/series|系列/i.test(text)) return false;
  return seriesTokenOf(text) !== '';
}

function isSingleStorageQuery(text) {
  const t = String(text || '');
  if (!/\d+\s*(gb|tb)\b/i.test(t)) return false;
  const model = /\b([as]\s?\d{1,2}|z\s?(fold|flip)|tab\s?s?\d{2}|fold|flip)\b/i.test(t);
  const priceWord = /\b(price|cost|how\s+much|berapa|harga|cheapest)\b/i.test(t)
    || /价格|多少钱|几钱|价钱|多少|最便宜|便宜|谁便宜|是不是最便宜/.test(t);
  return model || priceWord;
}

// 知识/定义问句词：问"是什么/怎么算/为什么/formula"等
const KNOWLEDGE_RE = /\bwhat\s+is\b|\bwhat\s+does\b|\bwhat'?s\b|\bhow\s+(?:is|are|do|does|did)\b|\bwhy\b|\bexplain\b|\bmeans?\b|\bmeaning\b|\bformula\b|\bcalculat(?:e|ed|es|ion|ing)\b|\bdefine\b|\bdefinition\b|\bhow\s+does\b|是什么|怎么算|怎样算|如何算|为什么|为何|解释|什么意思/i;

// 是否明确给了型号 + 容量（给了就算真查询，不当知识问句拦）
function hasModelAndCapacity(text) {
  const toks = queryTokens(text);
  const hasCap = toks.some((t) => /^\d+(GB|TB)$/.test(t));
  const hasModel = toks.some((t) => /^[AS]\d{1,2}$/.test(t)) || /\b(fold|flip|tab)\b/i.test(text);
  return hasCap && hasModel;
}

// 知识问句护栏（P1）：问定义/公式/原理且没给具体型号+容量 → 不进 Price Engine，落 AI Chat
function isKnowledgeQuestion(text) {
  if (!KNOWLEDGE_RE.test(String(text || ''))) return false;
  return !hasModelAndCapacity(text);
}

// 价格/分析意图总闸：命中任一即走 /api/records 数据逻辑，绝不进 AI 聊天
export function isPriceQuery(text) {
  if (isKnowledgeQuestion(text)) return false; // 知识问句优先放行给 AI Chat
  return isWhatIfQuery(text) || isTakeBackQuery(text) || isSeriesQuery(text) || isSingleStorageQuery(text);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────
// Take Back = Google Sheet Take back(S)（不是降价动作）。价格竞争另叫 Pricing Status。
// 单型号：始终完整卡（不论是否被压价）。
function renderTakeBackSingle(r, tb) {
  const lines = [`${r.model} ${r.capacity}`, ''];
  lines.push(`D3 lowest: ${r.our == null ? '—' : `RM${fmtMoney(r.our)}`}`);
  if (r.compName != null && r.compPrice != null) {
    lines.push(`Lowest competitor: ${r.compName} RM${fmtMoney(r.compPrice)}`);
  }
  lines.push('', 'Pricing Status:', pricingStatus(r.our, r.compName, r.compPrice));
  lines.push('', 'Take Back:', fmtTakeBack(tb));
  return lines.join('\n');
}

// 一条型号的完整段落（model 列表 / 被压价列表共用）
function takeBackBlock(r, cspMap) {
  const tb = takeBackOf(cspMap, r.model, r.capacity);
  return [
    `${r.model} ${r.capacity}`, '',
    'Pricing Status:', pricingStatus(r.our, r.compName, r.compPrice), '',
    'Take Back:', fmtTakeBack(tb),
  ].join('\n');
}

// 多型号列表；undercutOnly=true → 只列被竞品压价（series/all）；false → 列全部（model 各容量）
function renderTakeBackMulti(rows, cspMap, undercutOnly) {
  let list = rows;
  if (undercutOnly) {
    list = rows.filter((r) => r.diff != null && r.diff < -0.005).sort((a, b) => a.diff - b.diff);
    if (list.length === 0) return 'No models are currently undercut by competitors.';
  } else {
    list = [...rows].sort(sortByKey);
  }
  return list.map((r) => takeBackBlock(r, cspMap)).join(`\n\n${'—'.repeat(6)}\n`);
}

// 多候选歧义提示（P3）：与价格查询一致，不静默取第一个
function renderMultipleMatches(rows) {
  const names = [...new Set(rows.map((r) => `${r.model} ${r.capacity}`))].sort();
  return `Found multiple matches, please specify:\n${names.map((n) => `• ${n}`).join('\n')}`;
}

// ── 处理器 ───────────────────────────────────────────────────────────────────
async function handleTakeBack(text) {
  const onlyComp = detectCompetitor(text);
  const scope = parseScope(stripCompetitorNames(text));
  const [records, cspMap] = await Promise.all([fetchRecords(), fetchCsp()]);
  const shopMap = buildShopMap();
  const combos = buildCombos(records, shopMap);
  const rows = selectRows(combos, scope, onlyComp);
  if (rows.length === 0) {
    return (scope.kind === 'single' || scope.kind === 'model')
      ? `Couldn't find "${scope.label}" in current data. Try /watchlist to see what I track.`
      : `No models found for ${scope.label} in current data.`;
  }
  // 单一型号+容量：唯一命中→完整卡；多命中(网络/连接歧义)→提示指定（P3）
  if (scope.kind === 'single') {
    if (rows.length > 1) return renderMultipleMatches(rows);
    return renderTakeBackSingle(rows[0], takeBackOf(cspMap, rows[0].model, rows[0].capacity));
  }
  // 无容量带限定词(如 s26 plus)：列该型号各容量，不退化整系列、不只列被压价（P2）
  if (scope.kind === 'model') {
    if (rows.length === 1) return renderTakeBackSingle(rows[0], takeBackOf(cspMap, rows[0].model, rows[0].capacity));
    return renderTakeBackMulti(rows, cspMap, false);
  }
  // series / all / 指定竞品：只列被压价
  return renderTakeBackMulti(rows, cspMap, true);
}

async function handleSeries(text) {
  const scope = parseScope(text);
  const records = await fetchRecords();
  const shopMap = buildShopMap();
  const combos = buildCombos(records, shopMap);
  const rows = selectRows(combos, scope, null).filter((r) => r.our != null || r.compPrice != null);
  if (rows.length === 0) return `No models found for ${scope.label} in current data.`;
  rows.sort(sortByKey);
  const lines = [`${scope.label.toUpperCase()} — ${rows.length} model${rows.length > 1 ? 's' : ''}`, ''];
  const undercut = [];
  for (const r of rows) {
    const ourS = r.our != null ? `RM${fmtMoney(r.our)}` : '—';
    const compS = r.compPrice != null ? `${r.compName} RM${fmtMoney(r.compPrice)}` : 'no competitor';
    let verdict;
    if (r.diff == null) verdict = r.our == null ? '(not in our store)' : '✓ D3 only';
    else if (r.diff < -0.005) { verdict = `⚠ ${r.compName} cheaper by RM${fmtMoney(-r.diff)}`; undercut.push(r); }
    else if (r.diff > 0.005) verdict = `✓ D3 cheapest (by RM${fmtMoney(r.diff)})`;
    else verdict = '= tied cheapest';
    lines.push(`${r.model} ${r.capacity}`);
    lines.push(`  D3 ${ourS} | ${compS} → ${verdict}`);
  }
  lines.push('');
  if (undercut.length === 0) lines.push(`Summary: D3 is cheapest (or tied) across all ${rows.length} models. 🎉`);
  else lines.push(`Summary: ${undercut.length} of ${rows.length} model${rows.length > 1 ? 's' : ''} undercut by competitors → ${undercut.map((r) => `${r.model} ${r.capacity}`).join(', ')}.`);
  return lines.join('\n');
}

async function handleWhatIf(text) {
  const { amount } = parseReduction(text);
  if (amount == null) return 'How much lower? e.g. "what if lower RM200 for S26 Ultra 256GB".';
  // 先把降价短语 / RM<n> 从范围文本剥掉，否则 "RM100" 会被当成型号 token 污染匹配
  const scopeText = stripCompetitorNames(text)
    .replace(/(?:lower|reduce|cut|drop|降价?|减价?|降|减)\s*(?:by\s*)?(?:to\s*)?(?:rm\s*)?\d+(?:\.\d+)?/ig, ' ')
    .replace(/\brm\s*\d+(?:\.\d+)?/ig, ' ');
  const scope = parseScope(scopeText);
  const records = await fetchRecords();
  const shopMap = buildShopMap();
  const combos = buildCombos(records, shopMap);
  let rows = selectRows(combos, scope, null).filter((r) => r.our != null && r.compPrice != null);
  if (scope.kind === 'all') rows = rows.filter((r) => r.diff != null && r.diff < -0.005); // 无范围时只模拟当前被压的型号
  if (rows.length === 0) {
    return scope.kind === 'single'
      ? `Couldn't find "${scope.label}" with both our price and a competitor in current data.`
      : `No models to simulate for ${scope.label} (need both our price and a competitor right now).`;
  }
  rows.sort(sortByKey);
  const lines = [`What-if: D3 lower by RM${fmtMoney(amount)} — ${scope.label}`, ''];
  let reclaim = 0;
  for (const r of rows) {
    const newOur = Math.max(0, Number((r.our - amount).toFixed(2)));
    const beats = newOur <= r.compPrice + 0.005;
    if (beats) reclaim++;
    lines.push(`${r.model} ${r.capacity}`);
    lines.push(`  D3 RM${fmtMoney(r.our)} → RM${fmtMoney(newOur)} vs ${r.compName} RM${fmtMoney(r.compPrice)}`);
    lines.push(`  → ${beats ? `✓ now cheapest (by RM${fmtMoney(r.compPrice - newOur)})` : `still RM${fmtMoney(newOur - r.compPrice)} behind ${r.compName}`}`);
  }
  lines.push('');
  lines.push(`Summary: −RM${fmtMoney(amount)} would reclaim cheapest on ${reclaim} of ${rows.length} model${rows.length > 1 ? 's' : ''}.`);
  return lines.join('\n');
}

// 单型号价格查询（原逻辑：D3 各档 + 竞品 + 差价 + 谁最便宜）
async function handleSinglePrice(text) {
  const tokens = queryTokens(text);
  if (!tokens.some((tok) => /^\d+(GB|TB)$/.test(tok))) {
    return 'Which storage size? e.g. "A17 5G 256GB".';
  }
  const records = await fetchRecords();
  const matched = matchVariants(records, tokens);
  const combos = new Map();
  for (const m of matched) {
    const key = `${m.model} ${m.capacity}`.replace(/\s+/g, ' ').trim();
    if (!combos.has(key)) combos.set(key, []);
    combos.get(key).push(m);
  }
  if (combos.size === 0) {
    return `Couldn't find "${tokens.join(' ')}" in current data. Try /watchlist to see what I track.`;
  }
  if (combos.size > 1) {
    const names = [...combos.keys()];
    return `Found multiple matches: ${names.join(', ')}. Please specify one, e.g. "${names[0]}".`;
  }
  const shopMap = buildShopMap();
  const [name, items] = [...combos.entries()][0];
  return renderReport(name, items, shopMap);
}

// 给 AI Chat Mode 用的实时市场快照（复用 buildCombos/undercut）。
// 含被压价清单 + 各竞品压价次数（回答"哪个竞品最 aggressive/危险"）。数字全来自 /api/records。
export async function buildMarketContext() {
  let records;
  try {
    records = await fetchRecords();
  } catch (error) {
    logHermes(`AI 上下文取 records 失败：${error.message || String(error)}`);
    return 'Live price-competition data is temporarily unavailable.';
  }
  const shopMap = buildShopMap();
  const combos = buildCombos(records, shopMap);
  const rows = [...combos.values()].map((c) => comboRow(c, null));
  const priced = rows.filter((r) => r.our != null);
  const undercut = rows.filter((r) => r.diff != null && r.diff < -0.005).sort((a, b) => a.diff - b.diff);
  const lines = [`Tracked model+capacity combos: ${rows.length} (with our price: ${priced.length}).`];
  if (undercut.length === 0) {
    lines.push('We are cheapest or tied on every tracked model right now — no competitor is undercutting us.');
    return lines.join('\n');
  }
  const tally = {};
  for (const r of undercut) tally[r.compName] = (tally[r.compName] || 0) + 1;
  const tallyStr = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`).join(', ');
  lines.push(`Competitors are cheaper than us on ${undercut.length} model(s). Most aggressive (by # of models undercut): ${tallyStr}.`);
  for (const r of undercut.slice(0, 15)) {
    lines.push(`  - ${r.model} ${r.capacity}: ${r.compName} RM${fmtMoney(r.compPrice)} vs our RM${fmtMoney(r.our)} (RM${fmtMoney(-r.diff)} under us)`);
  }
  if (undercut.length > 15) lines.push(`  - (+${undercut.length - 15} more models undercut)`);
  return lines.join('\n');
}

// Intent Layer 总入口：what-if → take back → series → 单型号价格。数字只来自 /api/records。
export async function handlePriceQuery(text) {
  try {
    if (isWhatIfQuery(text)) return await handleWhatIf(text);
    if (isTakeBackQuery(text)) return await handleTakeBack(text);
    if (isSeriesQuery(text)) return await handleSeries(text);
    return await handleSinglePrice(text);
  } catch (error) {
    logHermes(`价格查询失败：${error.message || String(error)}`);
    if (/records|HTTP|abort|fetch|network|timeout/i.test(error.message || '')) {
      return 'Price data is temporarily unavailable. Please try again in a moment.';
    }
    return 'Sorry, I hit an error looking that up. Please try again.';
  }
}
