const MODEL_PATTERNS = [
  { regex: /\bA0?(\d{1,2})\s*(5G|LTE|4G)?\b/i, map: (_, num, suffix) => `A${String(num).padStart(2, '0')}${suffix ? ` ${suffix.toUpperCase()}` : ''}` },
  { regex: /\bS\s*(2\d)\s*(Ultra|\+|Plus)?\b/i, map: (_, num, suffix) => `S${num}${suffix ? (suffix === '+' ? '+' : suffix.toLowerCase() === 'plus' ? '+' : ' Ultra') : ''}` },
  { regex: /\bZ\s*(Flip|Fold)\s*(\d)\b/i, map: (_, family, num) => `Z ${family[0].toUpperCase()}${family.slice(1).toLowerCase()} ${num}` },
  { regex: /\bTab\s*(A\d+|S\d+\s*(?:FE|Lite|Ultra)?)\b/i, map: (_, model) => `Tab ${String(model).replace(/\s+/g, ' ').trim()}` },
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
  const withoutModel = text.replace(/^A0?\d{1,2}(?:5G|4G|LTE)?/i, '').replace(/^S2\d(?:Ultra|\+|Plus)?/i, '').trim();
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
  if (/promo/i.test(raw)) return raw.match(/promo(?:\s*\(gift set\)|\s*\d+)?/i)?.[0] || 'Promo';
  if (/basic/i.test(raw)) return raw.match(/basic(?:\s*\d+)?/i)?.[0] || 'Basic';
  if (/gift\s*set|gift/i.test(raw)) return raw.match(/gift(?:\s*set|\s*\d+)?/i)?.[0] || 'Gift';
  if (/set\s*[a-z0-9]+/i.test(raw)) return raw.match(/set\s*[a-z0-9]+/i)?.[0] || raw;
  if (/standard/i.test(raw)) return 'Standard';
  if (/demo/i.test(raw)) return 'Demo';
  return '';
}

function extractModel(text) {
  const source = normalizeSpaces(text);
  let compact = source.match(/^A(0?\d{1,2})\s*(5G|4G|LTE)?/i);
  if (compact) return `A${String(compact[1]).padStart(2, '0')}${compact[2] ? ` ${compact[2].toUpperCase()}` : ''}`;
  compact = source.match(/^S(2\d)\s*(Ultra|\+|Plus)?/i);
  if (compact) return `S${compact[1]}${compact[2] ? (compact[2] === '+' ? '+' : compact[2].toLowerCase() === 'plus' ? '+' : ' Ultra') : ''}`;
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
    .replace(/^S2\d(?:Ultra|\+|Plus)?/i, '')
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

  const modelFromName = extractModel(name);
  const titleModel = !isMixedLabel(title) ? extractModel(title) : '';
  const itemModelResolved = !isMixedLabel(itemModel) ? itemModel : '';
  const model = modelFromName || titleModel || itemModelResolved || '';

  let capacity = normalizeCapacity(name);
  if (!capacity) capacity = masterCapacityFor(model, name, title);
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
