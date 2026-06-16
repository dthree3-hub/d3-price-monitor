// samsung-master.mjs — Samsung 权威型号字典（来源：Sarah 的 Market Price List.xlsx「Samsung」表）。
// 用途：① Canonical SKU Dictionary ② Trace 校验 ③ 未来「代码优先匹配」④ 无冲突评分校验。
// ⚠️ 纯数据 + 查询助手。本文件不修改 scraper / parser / matching / 写库逻辑。
// canonical 用「我们解析器的型号键」约定：手机 A 系列带网络(4G/5G)；S 手机不带网络；平板加 "Tab" 前缀 + 网络(WiFi/4G/5G)。
// 网络统一为 WiFi / 4G / 5G（Excel 的 LTE 归为 4G）。code 大写为键，匹配时大小写不敏感。

// 厂方型号代码 → 标准型号。code 末位规律：A 系列 5=4G、6=5G。
export const MODEL_CODES = {
  // ── 手机 A 系列（4G/5G 双版，靠代码末位区分）──
  A065: { canonical: 'A06 4G',  family: 'A06',  network: '4G', capacities: ['4+128'] },
  A066: { canonical: 'A06 5G',  family: 'A06',  network: '5G', capacities: ['6+128'] },
  A075: { canonical: 'A07 4G',  family: 'A07',  network: '4G', capacities: ['8+256'] },
  A076: { canonical: 'A07 5G',  family: 'A07',  network: '5G', capacities: ['8+256'] },
  A165: { canonical: 'A16 4G',  family: 'A16',  network: '4G', capacities: ['8+256'] },
  A166: { canonical: 'A16 5G',  family: 'A16',  network: '5G', capacities: ['8+256'] },
  A175: { canonical: 'A17 4G',  family: 'A17',  network: '4G', capacities: ['8+256'] },
  A176: { canonical: 'A17 5G',  family: 'A17',  network: '5G', capacities: ['8+256'] },
  // ── 手机 A 系列（只 5G）──
  A266: { canonical: 'A26 5G',  family: 'A26',  network: '5G', capacities: ['8+256'] },
  A366: { canonical: 'A36 5G',  family: 'A36',  network: '5G', capacities: ['12+256'] },
  A376: { canonical: 'A37 5G',  family: 'A37',  network: '5G', capacities: ['12+256'] },
  A566: { canonical: 'A56 5G',  family: 'A56',  network: '5G', capacities: ['12+256'] },
  A576: { canonical: 'A57 5G',  family: 'A57',  network: '5G', capacities: ['12+256', '12+512'] },
  // ── 手机 S 系列（型号键不带网络）──
  S731: { canonical: 'S25 FE',    family: 'S25 FE',    network: '5G', capacities: ['8+256', '8+512'] },
  S931: { canonical: 'S25',       family: 'S25',       network: '5G', capacities: ['12+256', '12+512'] },
  S936: { canonical: 'S25+',      family: 'S25+',      network: '5G', capacities: ['12+256', '12+512'] },
  S938: { canonical: 'S25 Ultra', family: 'S25 Ultra', network: '5G', capacities: ['12+256', '12+512', '12+1TB'] },
  S942: { canonical: 'S26',       family: 'S26',       network: '5G', capacities: ['12+256', '12+512'] },
  S947: { canonical: 'S26+',      family: 'S26+',      network: '5G', capacities: ['12+256', '12+512'] },
  S948: { canonical: 'S26 Ultra', family: 'S26 Ultra', network: '5G', capacities: ['12+256', '12+512', '16+1TB'] },
  // ── 平板（Tab 前缀 + 网络）──
  X133:  { canonical: 'Tab A11 WiFi',       family: 'Tab A11',        network: 'WiFi', capacities: ['4+64', '8+128'] },
  X135G: { canonical: 'Tab A11 4G',         family: 'Tab A11',        network: '4G',   capacities: ['8+128'] },
  X230:  { canonical: 'Tab A11+ WiFi',      family: 'Tab A11+',       network: 'WiFi', capacities: ['6+128'] },
  X400:  { canonical: 'Tab S10 Lite WiFi',  family: 'Tab S10 Lite',   network: 'WiFi', capacities: ['128'] },
  X406:  { canonical: 'Tab S10 Lite 5G',    family: 'Tab S10 Lite',   network: '5G',   capacities: ['128'] },
  X520:  { canonical: 'Tab S10 FE WiFi',    family: 'Tab S10 FE',     network: 'WiFi', capacities: ['256'] },
  X620:  { canonical: 'Tab S10 FE+ WiFi',   family: 'Tab S10 FE+',    network: 'WiFi', capacities: ['256'] },
  X626:  { canonical: 'Tab S10 FE+ 5G',     family: 'Tab S10 FE+',    network: '5G',   capacities: ['256'] },
  X820:  { canonical: 'Tab S10+ WiFi',      family: 'Tab S10+',       network: 'WiFi', capacities: ['256'] },
  X920:  { canonical: 'Tab S10 Ultra WiFi', family: 'Tab S10 Ultra',  network: 'WiFi', capacities: ['256'] },
  X730:  { canonical: 'Tab S11 WiFi',       family: 'Tab S11',        network: 'WiFi', capacities: ['256'] },
  X930:  { canonical: 'Tab S11 Ultra WiFi', family: 'Tab S11 Ultra',  network: 'WiFi', capacities: ['256', '512'] },
  X936:  { canonical: 'Tab S11 Ultra 5G',   family: 'Tab S11 Ultra',  network: '5G',   capacities: ['256', '512'] },
  // ── 耳机 ──
  R410: { canonical: 'Buds Core',  family: 'Buds Core',  network: '', capacities: [] },
  R420: { canonical: 'Buds 3 FE',  family: 'Buds 3 FE',  network: '', capacities: [] },
  R530: { canonical: 'Buds 3',     family: 'Buds 3',     network: '', capacities: [] },
  R540: { canonical: 'Buds 4',     family: 'Buds 4',     network: '', capacities: [] },
  R630: { canonical: 'Buds 3 Pro', family: 'Buds 3 Pro', network: '', capacities: [] },
  R640: { canonical: 'Buds 4 Pro', family: 'Buds 4 Pro', network: '', capacities: [] },
  // ── 手表 / 手环（canonical 按 Leon 指定命名）──
  R390:     { canonical: 'Fit 3',                   family: 'Fit 3',           network: '',    capacities: [] },
  L705:     { canonical: 'Watch Ultra 2025',        family: 'Watch Ultra',     network: '',    capacities: [] },
  L705N:    { canonical: 'Watch Ultra 2025',        family: 'Watch Ultra',     network: '',    capacities: [] },
  L7052025: { canonical: 'Watch Ultra 2025',        family: 'Watch Ultra',     network: '',    capacities: [] },
  L320:     { canonical: 'Watch 8 40mm BT',         family: 'Watch 8',         network: 'BT',  capacities: [] },
  L325:     { canonical: 'Watch 8 40mm LTE',        family: 'Watch 8',         network: 'LTE', capacities: [] },
  L330:     { canonical: 'Watch 8 44mm BT',         family: 'Watch 8',         network: 'BT',  capacities: [] },
  L335:     { canonical: 'Watch 8 44mm LTE',        family: 'Watch 8',         network: 'LTE', capacities: [] },
  L500:     { canonical: 'Watch 8 Classic 46mm BT', family: 'Watch 8 Classic', network: 'BT',  capacities: [] },
  L505:     { canonical: 'Watch 8 Classic 46mm LTE',family: 'Watch 8 Classic', network: 'LTE', capacities: [] },
  // ── 折叠屏（代码来自 Book1）──
  F761: { canonical: 'Z Flip 7 FE', family: 'Z Flip 7 FE', network: '5G', capacities: ['8+128', '8+256'] },
  F766: { canonical: 'Z Flip 7',    family: 'Z Flip 7',    network: '5G', capacities: ['12+256', '12+512'] },
  F966: { canonical: 'Z Fold 7',    family: 'Z Fold 7',    network: '5G', capacities: ['12+256', '12+512', '16+1TB'] },
};

// 补充合法型号（master 代码表没覆盖、但确为真实在售型号）——用于 isKnownModel 校验，避免误判 off-master。
export const EXTRA_VALID_MODELS = new Set([
  'Z Flip 7', 'Z Flip 7 FE', 'Z Fold 7',
  'Tab S10 Ultra 5G', 'Tab S10 FE 5G', 'Tab S11 Ultra 5G', 'Tab S11 5G',
  'Buds Core',
]);

// 合法型号集合（canonical 去重）——用于「解析出的 SKU 在不在权威清单内」校验。
export const CANONICAL_MODELS = new Set(Object.values(MODEL_CODES).map((e) => e.canonical));

// 合法「型号家族」集合（去网络）——更宽松的校验（型号对、网络可能没抓到时仍算已知型号）。
export const MODEL_FAMILIES = new Set(Object.values(MODEL_CODES).map((e) => e.family));

// 代码提取正则：只匹配「已知代码」（按长度降序，确保 L7052025 先于 L705、X135G 先于 X133）。
const CODE_RE = new RegExp(
  '\\b(' + Object.keys(MODEL_CODES)
    .sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')\\b',
  'i',
);

// 从一段文字（标题 / 款式名）里抠出已知型号代码，命中则返回 {code, canonical, family, network, capacities}；否则 null。
export function lookupModelByCode(text) {
  const m = String(text || '').match(CODE_RE);
  if (!m) return null;
  const code = m[1].toUpperCase();
  return { code, ...MODEL_CODES[code] };
}

// 仅「可穿戴」(手表/手环/耳机)代码 → 供 parser 代码优先；不含手机/平板，确保只改可穿戴解析。
export const WEARABLE_CODES = new Set(
  Object.entries(MODEL_CODES).filter(([, v]) => /watch|buds|fit/i.test(v.canonical)).map(([k]) => k)
);
export function lookupWearableByCode(text) {
  const r = lookupModelByCode(text);
  return r && WEARABLE_CODES.has(r.code) ? r : null;
}

// 校验：解析出的型号是否在权威清单内。先比 canonical（连网络），再比 family（只型号）。
// 大小写/空格不敏感；A26/A36/A56 这类前端会去 5G，故 canonical 去掉 " 5G" 后也认。
export function isKnownModel(model) {
  const base = String(model || '').replace(/\s+/g, ' ').trim();
  if (!base) return false;
  // 先按原样比；再试 LTE→4G（平板 Tab A11 LTE↔4G）。手表 canonical 本身含 LTE，故必须保留原样这一支。
  const cands = new Set([
    base.toLowerCase(),
    base.replace(/\bLTE\b/gi, '4G').replace(/\s+/g, ' ').trim().toLowerCase(),
  ]);
  for (const lc of cands) {
    for (const c of CANONICAL_MODELS) {
      if (c.toLowerCase() === lc) return true;
      if (c.toLowerCase().replace(/ 5g$/, '') === lc) return true; // A26 5G ↔ A26
    }
    for (const f of MODEL_FAMILIES) if (f.toLowerCase() === lc) return true;
    for (const e of EXTRA_VALID_MODELS) if (e.toLowerCase() === lc) return true;
  }
  return false;
}

// 产品大类：watch / buds / tablet / phone / unknown（按 canonical 名判断，供审计分类）。
export function modelCategory(model) {
  const m = String(model || '');
  if (/watch|fit/i.test(m)) return 'watch'; // 注意 "Watch8" 无词边界，不能用 \bWatch\b
  if (/buds/i.test(m)) return 'buds';
  if (/^Tab\b|\bTab\b/i.test(m)) return 'tablet';
  if (m.trim()) return 'phone';
  return 'unknown';
}
