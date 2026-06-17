import { lookupWearableByCode } from './samsung-master.mjs';

const MODEL_PATTERNS = [
  { regex: /\bA0?(\d{1,2})\s*(\+|Plus)?\s*(5G|LTE|4G)?\b/i, map: (_, num, plus, net) => `A${String(num).padStart(2, '0')}${plus ? '+' : ''}${net ? ` ${net.toUpperCase()}` : ''}` },
  { regex: /\bS\s*(2\d)(?![0-9])\s*(Ultra|U(?![A-Za-z])|FE\s*\+|FE\s*Plus|FE|\+|Plus)?/i, map: (_, num, suffix) => {
    const raw = String(suffix || '').toLowerCase().replace(/\s+/g, '');
    const suf = (raw === 'ultra' || raw === 'u') ? ' Ultra'
      : (raw === 'fe+' || raw === 'feplus') ? ' FE+'
      : (raw === 'fe') ? ' FE'
      : (raw === '+' || raw === 'plus') ? '+' : '';
    return `S${num}${suf}`;
  } },
  { regex: /\b(?:Z\s*)?(Flip|Fold)\s*(\d)\s*(FE)?/i, map: (_, family, num, fe) => `Z ${family[0].toUpperCase()}${family.slice(1).toLowerCase()} ${num}${fe ? ' FE' : ''}` },
  { regex: /\bTab\s*(A\d+|S\d+\s*(?:FE|Lite|Ultra)?)\b/i, map: (_, model) => `Tab ${String(model).replace(/\s+/g, ' ').trim()}` },
  // 平板 S 系列紧凑写法(无 "Tab" 前缀、可无空格)：S10Lite / S10 Lite / S11Ultra / S10FE → "S1x ..."(后续会补 Tab 前缀)。
  // 只认 S1x(平板)，不碰 S2x(手机)。用于多型号混合 listing 的「Model+Color」选项里。
  { regex: /\bS(1\d)(?![0-9])\s*(Ultra|U(?![A-Za-z])|FE\s*\+|FE\s*Plus|FE|Lite|\+|Plus)?/i, map: (_, num, suf) => {
    const raw = String(suf || '').toLowerCase().replace(/\s+/g, '');
    const suffix = (raw === 'ultra' || raw === 'u') ? ' Ultra'
      : (raw === 'fe+' || raw === 'feplus') ? ' FE+'
      : (raw === 'fe') ? ' FE'
      : (raw === 'lite') ? ' Lite'
      : (raw === '+' || raw === 'plus') ? '+' : '';
    return `S${num}${suffix}`;
  } },
  // Watch 已移出通用 lossy 表 → 见 resolveWatchModel（多家族同串会 drop，避免 standalone 误分类）。
  { regex: /\bBuds\s*(\d+\s*FE|\d+\s*Pro|\d+|Core)\b/i, map: (_, model) => {
    // 规整大小写：卖家可能写 BUDS CORE / BUDS4 PRO → 统一成 canonical Core / Pro（FE 保持大写），避免大小写重复桶。
    const t = String(model).replace(/\s+/g, ' ').trim()
      .replace(/\bfe\b/i, 'FE')
      .replace(/\bpro\b/i, 'Pro')
      .replace(/\bcore\b/i, 'Core');
    return `Buds ${t}`;
  } },
  { regex: /\bFit\s*(\d+)\b/i, map: (_, num) => `Fit ${num}` },
];

const COLOR_TERMS = [
  'Awesome Icyblue', 'Awesome Gray', 'Awesome Navy', 'Awesome Blue', 'Awesome Black', 'Awesome White',
  'Icy Blue', 'P.Gold', 'Peach Gold', 'Light Blue', 'Sky Blue', 'Cobalt Violet',
  'Olive', 'Violet', 'Purple', 'Black', 'White', 'Blue', 'Silver', 'Gray', 'Grey',
  'Gold', 'Green', 'Pink', 'Navy', 'Cream', 'Coral', 'Mint', 'Lavender', 'Yellow',
];

function normalizeSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// ── TAC 手表简写解析（仅 shop C 的 listing 9812470630 这种格式）──
// 卖家用极简写：W8/W6 = Watch 8/6、W8 CLASSIC = Watch 8 Classic、W ULRA = Watch Ultra(把 ULTRA 拼成 ULRA)。
// 连接性：BH = 蓝牙(BT)、LTE = LTE；尺寸 40/44/46MM。门控正则要求款式名以 "W6/W8/W ULRA" 开头，
// 手机(S/A/Z)、平板(Tab/S1x)绝不会以此开头 → 只命中手表，不影响其它 parser 路径。
// Watch 6 / Watch Ultra 2024 自家店不卖、无可比项 → 直接 drop（返回 null），不进 Dashboard（Leon 2026-06-16 确认）。
const TAC_WATCH_SHORTHAND_RE = /^W\s*(?:6|8|ULRA|ULTRA)\b/i;

function tacWatchColor(name) {
  // 颜色可能与年份/尺寸粘连(如 "2025WHITE")，故用子串匹配(本函数已被严格门控，不会误伤其它品类)。
  const s = String(name || '').toUpperCase();
  if (/GRAPHITE/.test(s)) return 'Graphite';
  if (/SILVER|SILV/.test(s)) return 'Silver';
  if (/GRAY|GREY/.test(s)) return 'Gray';
  if (/BLACK/.test(s)) return 'Black';
  if (/WHITE/.test(s)) return 'White';
  if (/BLUE/.test(s)) return 'Blue';
  return '';
}

function resolveTacWatchShorthand(name) {
  if (!TAC_WATCH_SHORTHAND_RE.test(name)) return null;
  const s = String(name).toUpperCase();
  const net = /\bLTE\b/.test(s) ? 'LTE' : 'BT'; // BH(默认) = 蓝牙；显式 LTE = LTE
  const size = (s.match(/\b(40|44|46)\s*MM\b/) || [])[1] || '';
  let model = '';
  if (/^W\s*(?:ULRA|ULTRA)\b/i.test(name)) {
    const year = (s.match(/(?<![0-9])(2024|2025)(?![0-9])/) || [])[1] || '2025'; // 年份可能与颜色粘连(2024WHITE)
    if (year === '2024') return null; // 自家不卖 Watch Ultra 2024 → drop
    model = `Watch Ultra ${year}`; // Ultra canonical 不带 BT/LTE 后缀(对齐 master L705)
  } else if (/^W\s*8\s*CLASSIC\b/i.test(name)) {
    model = `Watch 8 Classic 46mm ${net}`; // Classic 仅 46mm
  } else if (/^W\s*8\b/i.test(name)) {
    model = size ? `Watch 8 ${size}mm ${net}` : `Watch 8 ${net}`;
  } else if (/^W\s*6\b/i.test(name)) {
    return null; // 自家不卖 Watch 6 → drop
  }
  return model || null;
}

function normalizeCapacity(raw) {
  const text = normalizeSpaces(raw).replace(/[()]/g, '');
  // 抠容量前先去掉型号 token（不限行首，全局）——否则像 "S25+ 256GB" 的 "25+256" 会被误当 RAM+ROM。
  const withoutModel = text
    .replace(/\bA0?\d{1,2}\s*(?:\+|Plus)?\s*(?:5G|4G|LTE)?/ig, ' ')
    .replace(/\bS2\d(?:Ultra|U(?![A-Za-z])|\+|Plus)?/ig, ' ')
    .replace(/\b(?:Tab\s*)?S1\d\s*(?:Ultra|U(?![A-Za-z])|FE\s*\+?|Lite|\+|Plus)?/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const source = withoutModel && withoutModel !== text ? withoutModel : text;
  const ramRom = source.match(/(\d+)\s*(?:GB|TB)?\s*\+\s*(\d+)\s*(GB|TB)?/i);
  if (ramRom) return `${ramRom[1]}+${ramRom[2]}${(ramRom[3] || 'GB').toUpperCase()}`;
  const compactRamRom = source.match(/(\d+)\+(\d+)(GB|TB)/i);
  if (compactRamRom) return `${compactRamRom[1]}+${compactRamRom[2]}${compactRamRom[3].toUpperCase()}`;
  const storage = source.match(/\b(\d+)\s*(GB|TB)\b/i);
  if (storage) return `${storage[1]}${storage[2].toUpperCase()}`;
  const bareStorage = source.match(/\b(128|256|512|1024)\b/i);
  if (bareStorage) return `${bareStorage[1]}GB`;
  const compactStorage = withoutModel.match(/(\d+)(GB|TB)/i);
  if (compactStorage) return `${compactStorage[1]}${compactStorage[2].toUpperCase()}`;
  // 粘在字母后的存储（如「11Ultra512」的 512、「Ultra256」的 256）——无 GB 也无左边界
  const glued = source.match(/(?<![0-9])(128|256|512|1024)(?![0-9])/);
  if (glued) return glued[1] === '1024' ? '1TB' : `${glued[1]}GB`;
  return '';
}

// 产品主数据：单容量机型「型号|网络 → 存储」补全表（Sarah 官方清单 config/product-master.txt）。
// 仅在 normalizeCapacity 解析不到容量时兜底；多容量机型(A57/S/Z/平板)不在此，靠款式名里的容量数字。
const MASTER_STORAGE = {
  'A06|4G': '128GB', 'A06|5G': '128GB',
  'A07|4G': '256GB', 'A07|5G': '256GB',
  'A16|4G': '256GB', 'A16|5G': '256GB',
  'A17|4G': '256GB', 'A17|5G': '256GB',
  'A26|5G': '256GB', 'A36|5G': '256GB', 'A37|5G': '256GB', 'A56|5G': '256GB',
  'A26|': '256GB', 'A36|': '256GB', 'A37|': '256GB', 'A56|': '256GB',
};

function masterCapacityFor(model, name, title) {
  if (/^Tab S10 Lite(?:\s+(?:WiFi|5G))?$/i.test(String(model || '').trim())) return '128GB';
  const hay = `${model || ''} ${name || ''} ${title || ''}`;
  const mm = hay.match(/\bA(0?\d{1,2})\b/i);
  if (!mm) return '';
  const base = `A${String(mm[1]).padStart(2, '0')}`;
  const netSource = `${model || ''} ${name || ''}`;
  const net = /\b5G\b/i.test(netSource) ? '5G' : (/\b(4G|LTE)\b/i.test(netSource) ? '4G' : '');
  return MASTER_STORAGE[`${base}|${net}`] || MASTER_STORAGE[`${base}|`] || '';
}

function extractTier(text) {
  const raw = normalizeSpaces(text);
  if (!raw) return '';
  if (/promo/i.test(raw)) {
    const gift = raw.match(/promo\s*\(gift set\)/i);
    return gift ? gift[0] : 'Promo'; // Promo / Promo1 / Promo 2 … → 统一归 Promo;Gift Set 保留单独
  }
  if (/offer/i.test(raw)) return 'Promo'; // Offer / Limited Offer = Promo（TAC 用这写法）
  if (/basic/i.test(raw)) return 'Basic'; // Basic / Basic1 … → 统一归 Basic
  if (/gift\s*set|gift/i.test(raw)) return raw.match(/gift(?:\s*set|\s*\d+)?/i)?.[0] || 'Gift';
  if (/set\s*[a-z0-9]+/i.test(raw)) return raw.match(/set\s*[a-z0-9]+/i)?.[0] || raw;
  if (/standard/i.test(raw)) return 'Standard';
  if (/demo/i.test(raw)) return 'Demo';
  return '';
}

// 手表型号精确解析（替代旧的通用 lossy「\bWatch\s*…」正则）。
// 关键 multi-family-drop：一段文字里出现「多个不同手表家族」(营销标题 "Watch 8 Classic Watch Ultra 2025"
// 或 mixed listing "Watch Ultra / Watch 8 / Watch 8 Classic") → 返回 ''，交由权威来源
// （厂方代号 lookupWearableByCode / itemModel）定型，避免 standalone 单品被「首个家族」误分类。
// 仅单一家族时给泛型标签 Watch Ultra / Watch N / Watch N Classic（细分尺寸/连接由 code-first 负责）。
// 用 \bwatch（仅前词边界）而非 \bWatch\b —— "Watch8" 后无词边界（见 samsung-master modelCategory 注释）。
export function resolveWatchModel(text) {
  const s = String(text || '');
  if (!/\bwatch/i.test(s)) return ''; // 不是手表：手机/平板里的 "Ultra" 不会被劫持
  const re = /watch\s*(ultra|(\d+)\s*classic|(\d+))/gi;
  const families = new Set();
  let m;
  while ((m = re.exec(s)) !== null) {
    if (/ultra/i.test(m[1])) families.add('Watch Ultra 2025');
    else if (m[2]) families.add(`Watch ${m[2]} Classic`);
    else if (m[3]) families.add(`Watch ${m[3]}`);
  }
  return families.size === 1 ? [...families][0] : ''; // 0=没解析出；>1=多家族 → drop
}

function extractModel(text) {
  // 剥掉赠品后缀如 "(+Buds Core)" / "(+ 15W Charger)"：以 + 开头的括号是赠品，不是型号；
  // 不碰容量括号 "(12+256)"（以数字开头）。否则手机会被误判成 Buds Core 等赠品名。
  const source = normalizeSpaces(String(text || '').replace(/\(\s*\+[^)]*\)/g, ' '));
  let compact = source.match(/^A(0?\d{1,2})\s*(\+|Plus)?\s*(5G|4G|LTE)?/i);
  if (compact) return `A${String(compact[1]).padStart(2, '0')}${compact[2] ? '+' : ''}${compact[3] ? ` ${compact[3].toUpperCase()}` : ''}`;
  compact = source.match(/^S(2\d)\s*(Ultra|U(?![A-Za-z])|FE\s*\+|FE\s*Plus|FE|\+|Plus)?/i);
  if (compact) {
    const raw = (compact[2] || '').toLowerCase().replace(/\s+/g, '');
    const suf = (raw === 'ultra' || raw === 'u') ? ' Ultra'
      : (raw === 'fe+' || raw === 'feplus') ? ' FE+'
      : (raw === 'fe') ? ' FE'
      : (raw === '+' || raw === 'plus') ? '+' : '';
    return `S${compact[1]}${suf}`;
  }
  // 平板 S 系列（S10/S11）：variant 名常无 "Tab" 前缀，"U" 缩写 = Ultra（如 S11U = S11 Ultra）；
  // 同时支持 FE/FE+/Lite/+ 后缀。families 与 Excel A 列一致（不带 Tab 前缀）。
  compact = source.match(/^(?:Tab\s*)?S(1\d)\s*(Ultra|U(?![A-Za-z])|FE\s*\+|FE\s*Plus|FE|Lite|\+|Plus)?/i);
  if (compact) {
    const raw = (compact[2] || '').toLowerCase().replace(/\s+/g, '');
    let suffix = '';
    if (raw === 'ultra' || raw === 'u') suffix = ' Ultra';
    else if (raw === 'fe+' || raw === 'feplus') suffix = ' FE+'; // FE+ / FE PLUS / FE +
    else if (raw === 'fe') suffix = ' FE';
    else if (raw === 'lite') suffix = ' Lite';
    else if (raw === '+' || raw === 'plus') suffix = '+';
    return `S${compact[1]}${suffix}`;
  }
  const watch = resolveWatchModel(source);
  if (watch) return watch;
  for (const pattern of MODEL_PATTERNS) {
    const match = source.match(pattern.regex);
    if (match) return normalizeSpaces(pattern.map(...match));
  }
  return '';
}

function isMixedLabel(text) {
  const source = String(text || '');
  return /mixed|\/.+\//i.test(source) || source.includes('/');
}

// 标题含 "/" 但各段其实是同一型号（如 "TAB A11+ WIFI / TAB A11 PLUS WIFI" 都是 A11+，
// 只是营销重复写）→ 返回该型号；真正多型号（各段不同，如 "S10+ / S10 Ultra"）→ 返回 ''，仍按 mixed 处理。
function consistentSlashModel(text) {
  const s = normalizeSpaces(text);
  if (!s.includes('/')) return '';
  const models = s.split('/').map((part) => extractModel(part)).filter(Boolean);
  if (!models.length) return '';
  return models.every((m) => m === models[0]) ? models[0] : '';
}

function stripKnownParts(text, parts) {
  let output = String(text || '');
  for (const part of parts.filter(Boolean)) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(escaped, 'ig'), ' ');
  }
  return normalizeSpaces(output.replace(/[,/]+/g, ' ').replace(/[()]/g, ' '));
}

function extractColor(text, knownCapacity = '', knownTier = '', knownModel = '') {
  const source = normalizeSpaces(text);
  for (const color of COLOR_TERMS) {
    const escaped = color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(source)) return color;
  }
  const stripped = stripKnownParts(source, [knownCapacity, knownTier, knownModel])
    .replace(/\b(?:5G|LTE|4G)\b/gi, '')
    .replace(/^A\d{2}(?:5G|4G|LTE)?/i, '')
    .replace(/^S2\d(?:Ultra|U(?![A-Za-z])|\+|Plus)?/i, '')
    .trim();
  if (!stripped) return '';
  const token = stripped.split(/\s+/).filter(Boolean).slice(-2).join(' ');
  return token || '';
}

function cleanModelLabel(label) {
  return normalizeSpaces(String(label || '')
    .replace(/^Samsung Galaxy\s+/i, '')
    .replace(/^Samsung\s+/i, '')
    .replace(/\s+Mixed$/i, ''));
}

export function parseVariantDescriptor(rawName, context = {}) {
  const name = normalizeSpaces(rawName || '');
  const title = normalizeSpaces(context.title || '');
  const itemModel = cleanModelLabel(context.itemModel || context.ourProduct || '');

  // ── 可穿戴代码优先（P1）──
  // 款式名里出现厂方可穿戴码(L320/L325/L330/L335/L500/L505/L705/R540/R640…)直接定型号，
  // 不依赖标题/关键字解析。仅可穿戴，手机/平板不受影响。手表无 GB 容量(尺寸已在型号里)。
  const wearable = lookupWearableByCode(name);
  if (wearable) {
    const wTier = extractTier(name);
    return {
      rawName: name || 'Default variant',
      model: wearable.canonical,
      color: extractColor(name, '', wTier, wearable.canonical) || '',
      capacity: '',
      tier: wTier || '',
      confidence: 'confirmed',
    };
  }

  // ── TAC 手表简写优先（仅 W6/W8/W ULRA 这种格式，门控见 resolveTacWatchShorthand）──
  // 放在厂方码之后、通用 extractModel 之前：这类款式名无厂方码、也不匹配 "Watch N" 正则，
  // 否则会回退到营销标题变成垃圾 model。手表无 GB 容量(尺寸已在型号里)。
  const tacWatchModel = resolveTacWatchShorthand(name);
  if (tacWatchModel) {
    const wTier = extractTier(name);
    return {
      rawName: name || 'Default variant',
      model: tacWatchModel,
      color: tacWatchColor(name),
      capacity: '',
      tier: wTier || '',
      confidence: 'confirmed',
    };
  }

  const modelFromName = extractModel(name);
  const titleModel = !isMixedLabel(title) ? extractModel(title) : '';
  // 标题含 "/" 但各段同型号(如 "A11+ WIFI / A11 PLUS WIFI") → 取该型号，避免误当 mixed 丢成基础款。
  const titleConsistentModel = !titleModel ? consistentSlashModel(title) : '';
  // itemModel 必须能解析出真型号才采信；像 "Our Store Listing" 这种占位文字不是型号，丢弃（否则会当成型号显示）。
  // 用提取出的「干净型号」，不是整串 itemModel/keyword——否则像「A06 5G A06 4G l 6.7' HD…」这种长标题会被整串当成 model。
  const itemModelResolved = (!isMixedLabel(itemModel) && extractModel(itemModel)) ? extractModel(itemModel) : '';
  let model = modelFromName || titleModel || titleConsistentModel || itemModelResolved || '';
  // 仅当型号是靠「标题单一型号」推出来的，才信任标题里的容量补全（标题是单型号时容量也唯一可信）。
  const usedTitleConsistent = !modelFromName && !titleModel && !!titleConsistentModel && model === titleConsistentModel;

  // ── 以款式名为准的覆盖（变体名才是 SKU 真相，优先于标题推来的型号）──
  // (a) FE+ 后缀：款式名写了 FE+/FE PLUS，但型号(常来自标题)只有 "FE" → 升级 FE+。
  //     例：变体名 "FE+ (12+256) Blue"、型号来自标题 "Tab S10 FE" → 应 Tab S10 FE+。
  if (/FE\s*\+|FE\s*PLUS/i.test(name) && /\bFE\b/i.test(model) && !/FE\+/i.test(model)) {
    model = model.replace(/\bFE\b/i, 'FE+');
  }
  // 变体名写了 Ultra / +（但 model 来自标题/itemModel 只是基础 S2x）→ 升级。
  // 例：S25 混合 listing 的变体「Ultra(256GB)」→ S25 Ultra；「+(256GB)」→ S25+。
  if (/\bUltra\b/i.test(name) && /^S2\d$/.test(model)) model = `${model} Ultra`;
  else if (/(?:^|[(\s])\+|\bPlus\b/i.test(name) && /^S2\d$/.test(model)) model = `${model}+`;
  // (b) 网络：款式名明确写了 WiFi/LTE/4G/5G → 覆盖型号里(可能来自标题)的网络。
  //     例：A17 listing 的变体名 "LTE (8+256GB)" 应 A17 4G，而非标题的 A17 5G（4G/5G 串的根因）。
  // 平板(Tab / A11 / A11+ / S10 / S11)保留 LTE；手机 LTE→4G(A07/A17 仍归一为 4G)。
  const isTabletModel = /^(?:Tab|A11\+?|S1[01])\b/i.test(model);
  const nameNet = /\bwifi\b/i.test(name) ? 'WiFi'
    : /\blte\b/i.test(name) ? (isTabletModel ? 'LTE' : '4G')
    : /\b4g\b/i.test(name) ? '4G'
    : /\b5g\b/i.test(name) ? '5G' : '';
  if (nameNet) {
    if (/\b(?:4G|5G|LTE|WiFi)\b/i.test(model)) {
      model = model.replace(/\b(?:4G|5G|LTE|WiFi)\b/i, nameNet);
    } else if (/^A(?:06|07|16|17)\b/i.test(model)) {
      model = `${model} ${nameNet}`; // 双网络手机：型号还没带网络时补上
    }
  }

  // (c) 网络回填：双网络手机(A06/07/16/17) 型号已命中但仍无网络、且款式名也没写网络 →
  //     从「同型号」的标题网络补齐。例：Deal Direct A07 LTE listing，变体名 "A07 Black"(无网络)
  //     + 标题 "A07 LTE 4G" → A07 4G。仅限 A06/07/16/17（不碰 5G-only 手机/平板/mixed）。
  //     titleModel 对 mixed listing 已是 ''(isMixedLabel 守卫) → 天然不触发，自家混合 listing 不受影响。
  if (/^A(?:06|07|16|17)\b/i.test(model) && !/\b(?:4G|5G|LTE|WiFi)\b/i.test(model)
      && titleModel && /\b(?:4G|5G|LTE|WiFi)\b/i.test(titleModel)) {
    const baseOf = (s) => s.replace(/\b(?:4G|5G|LTE|WiFi)\b/ig, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (baseOf(titleModel) === baseOf(model)) { // 禁止跨型号回填（A17 变体 + A07 标题 → base 不等 → 不补）
      const titleNet = /\bwifi\b/i.test(titleModel) ? 'WiFi'
        : /\b(?:lte|4g)\b/i.test(titleModel) ? '4G' // LTE 归一为 4G，与对手 A07 4G 对齐
        : '5G';
      model = `${model} ${titleNet}`;
    }
  }

  // 平板（A11 / S10 / S11 / Tab）：网络是 WiFi 或 LTE，且可能写在款式名任意位置；
  // 若型号还没带网络，就从款式名补上，让 WiFi 款和 LTE 款分成不同型号（对手价才对得上）。
  // 款式名没写网络时默认 WiFi（平板基础款=WiFi，LTE/5G 款都会明确标网络）——
  // 避免「Tab S10 Lite」与「Tab S10 Lite WiFi」拆成两行。
  if (/^(A11|S1\d|Tab)\b/i.test(model) && !/(wifi|lte|\b4g\b|\b5g\b)/i.test(model)) {
    const tabNet = /\bwifi\b/i.test(name) ? 'WiFi'
      : (/\blte\b/i.test(name) ? 'LTE'
      : (/\b5g\b/i.test(name) ? '5G'
      : (/\b4g\b/i.test(name) ? '4G' : 'WiFi')));
    model = `${model} ${tabNet}`;
  }
  // 统一平板带 "Tab" 前缀（A11 / S10 / S11 系列），避免 "S11 Ultra" 与 "Tab S11 Ultra" 拆成两行。
  if (/^(A11|S1\d)\b/i.test(model) && !/^Tab\b/i.test(model)) model = `Tab ${model}`;

  let capacity = normalizeCapacity(name);
  if (!capacity) capacity = masterCapacityFor(model, name, title);
  if (!capacity && usedTitleConsistent) capacity = normalizeCapacity(title);
  const tier = extractTier(name);
  const color = extractColor(name, capacity, tier, model);

  let confidence = 'uncertain';
  if (modelFromName) confidence = 'confirmed';
  else if (model && capacity) confidence = 'parsed';
  else if (model) confidence = 'fallback';

  return {
    rawName: name || 'Default variant',
    model: model || '',
    color: color || '',
    capacity: capacity || '',
    tier: tier || '',
    confidence,
  };
}
