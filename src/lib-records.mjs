import fs from 'node:fs';
import path from 'node:path';
import { parseVariantDescriptor } from './variant-parser.mjs';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export const dataDir = path.join(projectRoot, 'data');
export const recordsFile = path.join(dataDir, 'records.json');
export const reportFile = path.join(projectRoot, 'out', 'daily-report.md');

export function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(recordsFile)) fs.writeFileSync(recordsFile, '[]\n');
}

export function readRecords() {
  ensureDataFile();
  const raw = fs.readFileSync(recordsFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('data/records.json 不是数组');
  return parsed.map(normalizeRecord).filter(Boolean);
}

export function writeRecords(records) {
  ensureDataFile();
  fs.writeFileSync(recordsFile, `${JSON.stringify(sortRecords(records), null, 2)}\n`);
}

export function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (!Array.isArray(record.variants)) return null;

  const itemModel = String(record.ourProduct || record.itemModel || '');
  return {
    schemaVersion: Number(record.schemaVersion || 1),
    grabbedAt: String(record.grabbedAt || new Date().toISOString()),
    pageUrl: String(record.pageUrl || ''),
    shopId: String(record.shopId || ''),
    itemId: String(record.itemId || ''),
    sellerName: String(record.sellerName || ''),
    sourceSellerName: String(record.sourceSellerName || ''),
    competitor: String(record.competitor || ''),
    ourProduct: String(record.ourProduct || ''),
    ourPrice: String(record.ourPrice || ''),
    itemModel: String(record.itemModel || record.ourProduct || ''),
    title: String(record.title || '未命名商品'),
    currency: String(record.currency || 'MYR'),
    voucherAmount: toNumberOrNull(record.voucherAmount) ?? 0,
    soldOut: Boolean(record.soldOut),
    variants: record.variants
      .map((variant) => normalizeVariant(variant, {
        title: record.title,
        itemModel,
        ourProduct: record.ourProduct,
      }))
      .filter(Boolean),
  };
}

export function normalizeVariant(variant, context = {}) {
  if (!variant || typeof variant !== 'object') return null;
  const parsed = parseVariantDescriptor(variant.name, context);
  return {
    name: String(variant.name || parsed.rawName || '默认款式'),
    model: String(variant.model || parsed.model || ''),
    color: String(variant.color || parsed.color || ''),
    capacity: String(variant.capacity || parsed.capacity || ''),
    tier: String(variant.tier || parsed.tier || ''),
    confidence: String(variant.confidence || parsed.confidence || 'uncertain'),
    currentPrice: toNumberOrNull(variant.currentPrice),
    originalPrice: toNumberOrNull(variant.originalPrice),
    promoPrice: toNumberOrNull(variant.promoPrice),
    stock: variant.stock == null ? null : Number(variant.stock),
    inStock: Boolean(variant.inStock),
  };
}

export function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function recordKey(record) {
  return `${record.shopId}:${record.itemId}:${record.grabbedAt}`;
}

export function variantKey(record, variant) {
  return `${record.shopId}:${record.itemId}:${variant.name}`;
}

export function sortRecords(records) {
  return [...records].sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
}

export function mergeRecords(existing, incoming) {
  const byKey = new Map(existing.map((record) => [recordKey(record), normalizeRecord(record)]));
  for (const record of incoming.map(normalizeRecord).filter(Boolean)) {
    byKey.set(recordKey(record), record);
  }
  return sortRecords(Array.from(byKey.values()));
}

export function flattenRecords(records) {
  return records.flatMap((record) =>
    record.variants.map((variant) => ({
      grabbedAt: record.grabbedAt,
      pageUrl: record.pageUrl,
      shopId: record.shopId,
      itemId: record.itemId,
      sellerName: record.sellerName,
      title: record.title,
      currency: record.currency,
      variantName: variant.name,
      model: variant.model,
      color: variant.color,
      capacity: variant.capacity,
      tier: variant.tier,
      confidence: variant.confidence,
      currentPrice: variant.currentPrice,
      originalPrice: variant.originalPrice,
      promoPrice: variant.promoPrice,
      stock: variant.stock,
      inStock: variant.inStock,
    }))
  );
}

export function buildDropReport(records) {
  const historyByVariant = new Map();

  for (const record of sortRecords(records)) {
    for (const variant of record.variants) {
      const key = variantKey(record, variant);
      if (!historyByVariant.has(key)) historyByVariant.set(key, []);
      historyByVariant.get(key).push({
        grabbedAt: record.grabbedAt,
        pageUrl: record.pageUrl,
        shopId: record.shopId,
        itemId: record.itemId,
        sellerName: record.sellerName,
        title: record.title,
        currency: record.currency,
        variantName: variant.name,
        model: variant.model,
        color: variant.color,
        capacity: variant.capacity,
        tier: variant.tier,
        confidence: variant.confidence,
        currentPrice: variant.currentPrice,
        originalPrice: variant.originalPrice,
        promoPrice: variant.promoPrice,
        stock: variant.stock,
        inStock: variant.inStock,
      });
    }
  }

  const drops = [];
  for (const history of historyByVariant.values()) {
    history.sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
    if (history.length < 2) continue;

    const latest = history[0];
    const previous = history[1];
    if (latest.currentPrice == null || previous.currentPrice == null) continue;
    if (latest.currentPrice >= previous.currentPrice) continue;

    drops.push({
      ...latest,
      previousGrabbedAt: previous.grabbedAt,
      previousPrice: previous.currentPrice,
      dropAmount: Number((previous.currentPrice - latest.currentPrice).toFixed(2)),
    });
  }

  return drops.sort((a, b) => {
    const byAmount = b.dropAmount - a.dropAmount;
    if (byAmount !== 0) return byAmount;
    return new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime();
  });
}

export function buildChangeReport(records) {
  const historyByVariant = new Map();

  for (const record of sortRecords(records)) {
    for (const variant of record.variants) {
      const key = variantKey(record, variant);
      if (!historyByVariant.has(key)) historyByVariant.set(key, []);
      historyByVariant.get(key).push({
        grabbedAt: record.grabbedAt,
        pageUrl: record.pageUrl,
        shopId: record.shopId,
        itemId: record.itemId,
        sellerName: record.sellerName,
        title: record.title,
        currency: record.currency,
        variantName: variant.name,
        model: variant.model,
        color: variant.color,
        capacity: variant.capacity,
        tier: variant.tier,
        confidence: variant.confidence,
        currentPrice: variant.currentPrice,
        originalPrice: variant.originalPrice,
        promoPrice: variant.promoPrice,
        stock: variant.stock,
        inStock: variant.inStock,
      });
    }
  }

  const changes = [];
  for (const history of historyByVariant.values()) {
    history.sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
    const latest = history[0];
    const previous = history[1] || null;

    let status = 'same';
    let delta = null;
    if (!previous) {
      status = 'new';
    } else if (latest.currentPrice != null && previous.currentPrice != null) {
      delta = Number((latest.currentPrice - previous.currentPrice).toFixed(2));
      if (delta > 0) status = 'up';
      else if (delta < 0) status = 'down';
    } else if (latest.inStock !== previous.inStock) {
      status = latest.inStock ? 'restocked' : 'sold_out';
    }

    changes.push({
      ...latest,
      previousGrabbedAt: previous?.grabbedAt ?? null,
      previousPrice: previous?.currentPrice ?? null,
      previousInStock: previous?.inStock ?? null,
      delta,
      status,
    });
  }

  return changes.sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime());
}
