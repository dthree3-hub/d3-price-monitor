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
  { regex: /\bWatch\s*(Ultra|\d+\s*Classic|\d+)\b/i, map: (_, model) => `Watch ${String(model).replace(/\s+/g, ' ').trim()}` },
  { regex: /\bBuds\s*(\d+\s*FE|\d+\s*Pro|\d+|Core)\b/i, map: (_, model) => `Buds ${String(model).replace(/\s+/g, ' ').trim()}` },
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
  const nameNet = /\bwifi\b/i.test(name) ? 'WiFi'
    : /\b(?:lte|4g)\b/i.test(name) ? '4G'
    : /\b5g\b/i.test(name) ? '5G' : '';
  if (nameNet) {
    if (/\b(?:4G|5G|LTE|WiFi)\b/i.test(model)) {
      model = model.replace(/\b(?:4G|5G|LTE|WiFi)\b/i, nameNet);
    } else if (/^A(?:06|07|16|17)\b/i.test(model)) {
      model = `${model} ${nameNet}`; // 双网络手机：型号还没带网络时补上
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
