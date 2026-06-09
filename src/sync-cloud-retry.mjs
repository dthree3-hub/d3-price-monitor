import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile, logHermes } from './lib-hermes.mjs';
import { projectRoot } from './lib-records.mjs';

const DEFAULT_CLOUD_RECORDS_URL = 'https://api.jsonbin.io/v3/b/6a277a33f5f4af5e29cf0375';
const DEFAULT_RECORDS_FILE = path.join(projectRoot, 'data', 'records.json');
const EXCEL_SAMSUNG_MODEL_KEYS = new Set([
  // Derived from Market Price List.xlsx, Samsung sheet, on 2026-06-08.
  'A06 4G 128GB',
  'A06 5G 128GB',
  'A07 4G 256GB',
  'A07 5G 256GB',
  'A16 4G 256GB',
  'A16 5G 256GB',
  'A17 4G 256GB',
  'A17 5G 256GB',
  'A26 5G 256GB',
  'A36 5G 256GB',
  'A37 5G 256GB',
  'A56 5G 256GB',
  'A57 5G 256GB',
  'A57 5G 512GB',
  'S25 FE 256GB',
  'S25 FE 512GB',
  'S25 256GB',
  'S25 512GB',
  'S25+ 256GB',
  'S25+ 512GB',
  'S25 Ultra 256GB',
  'S25 Ultra 512GB',
  'S25 Ultra 1TB',
  'S26 256GB',
  'S26 512GB',
  'S26+ 256GB',
  'S26+ 512GB',
  'S26 Ultra 256GB',
  'S26 Ultra 512GB',
  'S26 Ultra 1TB',
  'Z Flip 7 FE 128GB',
  'Z Flip 7 FE 256GB',
  'Z Flip 7 256GB',
  'Z Flip 7 512GB',
  'Z Fold 7 256GB',
  'Z Fold 7 512GB',
  'Z Fold 7 1TB',
  'Tab A11 64GB',
  'Tab A11 128GB',
  'Tab A11 LTE 128GB',
  'Tab A11+ WiFi 128GB',
  'Tab S10 Lite WiFi 128GB',
  'Tab S10 Lite 5G 128GB',
  'Tab S10 FE 256GB',
  'Tab S10 FE+ 256GB',
  'Tab S10 FE+ 5G 256GB',
  'Tab S10+ WiFi 256GB',
  'Tab S10 Ultra WiFi 256GB',
  'Tab S10 Ultra 5G 256GB',
  'Tab S11 WiFi 256GB',
  'Tab S11 Ultra WiFi 256GB',
  'Tab S11 Ultra WiFi 512GB',
  'Tab S11 Ultra 5G 256GB',
  'Tab S11 Ultra 5G 512GB',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStorageValue(value) {
  const text = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (!text) return '';
  if (text === '1024GB') return '1TB';
  if (/^(64|128|256|512)$/.test(text)) return `${text}GB`;
  if (/^(64|128|256|512)GB$/.test(text)) return text;
  if (/^1TB$/.test(text)) return text;
  return text;
}

function storageOnly(value) {
  const text = String(value || '');
  const ramStorage = text.match(/\b\d+\s*(?:GB)?\s*[+/-]\s*((?:64|128|256|512)\s*(?:GB)?|1024\s*(?:GB)?|1\s*TB)\b/i);
  if (ramStorage) return normalizeStorageValue(ramStorage[1]);
  const matches = text.match(/\b(?:64|128|256|512)\s*GB\b|\b1024\s*GB\b|\b1\s*TB\b/gi);
  return matches ? normalizeStorageValue(matches[matches.length - 1]) : text;
}

function isStorageValue(value) {
  return /^(?:64|128|256|512)GB$|^1TB$/i.test(String(value || ''));
}

function normalizeStorageText(value) {
  return String(value || '')
    .replace(/\b\d+\s*GB\s*(?:RAM)?\s*[+\/-]\s*((?:64|128|256|512)\s*(?:GB)?|1024\s*(?:GB)?|1\s*TB)(?:\s*ROM)?\b/gi, (_, storage) => normalizeStorageValue(storage))
    .replace(/\b\d+\s*[+\/-]\s*((?:64|128|256|512)\s*(?:GB)?|1024\s*(?:GB)?|1\s*TB)\b/gi, (_, storage) => normalizeStorageValue(storage))
    .replace(/\b\d+\s*GB\s+RAM\s*\+\s*((?:64|128|256|512)\s*(?:GB)?|1024\s*(?:GB)?|1\s*TB)\s*ROM\b/gi, (_, storage) => normalizeStorageValue(storage));
}

function normalizeNetworkText(value) {
  const text = String(value || '');
  if (/\b(?:Tab|Watch)\b/i.test(text)) return text;
  return text.replace(/\bLTE\b/gi, '4G');
}

function inferNetwork(name) {
  const match = normalizeNetworkText(name).match(/\b(4G|5G)\b/i);
  return match ? match[1].toUpperCase() : '';
}

function inferTier(name, currentTier) {
  const tier = String(currentTier || '').trim();
  if (/^(?:set\s*)?[abc]$/i.test(tier)) return tier.replace(/^set\s*/i, '').toUpperCase();

  const text = String(name || '').trim();
  const match = text.match(/(?:^|[,/\s])(?:set\s*)?([ABC])$/i);
  if (match) return match[1].toUpperCase();
  if (/(?:^|[,/\s])Offer\s*\(\s*Gift\s*Set\s*\)/i.test(text)) return 'Promo(Gift Set)';
  if (/(?:^|[,/\s])Offer\b/i.test(text)) return 'Promo';
  return tier;
}

function normalizeModel(model, name) {
  let next = normalizeNetworkText(model).replace(/\s+/g, ' ').trim();
  const network = inferNetwork(name);
  if (network && /\bA\d{2}\b/i.test(next)) {
    if (/\b(?:4G|5G)\b/i.test(next)) {
      next = next.replace(/\b(?:4G|5G)\b/i, network);
    } else {
      next = `${next} ${network}`;
    }
  }
  return next;
}

function normalizeCaseModel(model) {
  return String(model || '')
    .replace(/^s(\d+)/i, 'S$1')
    .replace(/\bFE\b/gi, 'FE')
    .replace(/\bUltra\b/gi, 'Ultra')
    .replace(/\b(S\d+|Tab S\d+(?: FE)?)\s+Plus\b/gi, '$1+')
    .replace(/\b(S\d+|Tab S\d+(?: FE)?)\s+\+/gi, '$1+')
    .replace(/\bFlip\b/gi, 'Flip')
    .replace(/\bFold\b/gi, 'Fold')
    .replace(/\bWiFi\b/gi, 'WiFi')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOfficialBase(text) {
  const source = normalizeNetworkText(text)
    .replace(/^Samsung Galaxy\s+/i, '')
    .replace(/^Samsung\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return '';

  let match = source.match(/\bA0?(\d{1,2})\s*(4G|5G)?\b/i);
  if (match) {
    const network = (match[2] || inferNetwork(source)).toUpperCase();
    return network ? `A${String(match[1]).padStart(2, '0')} ${network}` : '';
  }

  match = source.match(/\bS\s*(2\d)\s*(FE|Ultra|\+|Plus)?(?=\s|$|[(/,-])/i);
  if (match) {
    const suffix = match[2]
      ? (match[2] === '+' || match[2].toLowerCase() === 'plus' ? '+' : ` ${match[2].toLowerCase() === 'fe' ? 'FE' : 'Ultra'}`)
      : '';
    return `S${match[1]}${suffix}`;
  }

  match = source.match(/\b(?:Z\s*)?(Flip|Fold)\s*(\d+)\s*(FE)?\b/i);
  if (match) {
    return `Z ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${match[2]}${match[3] ? ' FE' : ''}`;
  }

  match = source.match(/\bTab\s*(A\d+\+?|S\d+\s*(?:FE\+?|Lite|Ultra|\+)?)(?:\s*(WiFi|WIFI|5G|LTE))?\b/i);
  if (match) {
    const base = normalizeCaseModel(`Tab ${match[1]}`);
    const network = match[2] ? ` ${match[2].toUpperCase() === 'WIFI' ? 'WiFi' : match[2].toUpperCase()}` : '';
    return `${base}${network}`.trim();
  }

  return '';
}

function extractAseriesFamily(text) {
  const source = normalizeNetworkText(text)
    .replace(/^Samsung Galaxy\s+/i, '')
    .replace(/^Samsung\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = source.match(/\bA0?(\d{1,2})\b/i);
  return match ? `A${String(match[1]).padStart(2, '0')}` : '';
}

function applyVariantNetwork(base, variantNetwork) {
  if (!variantNetwork || !/^A\d{2}\b/i.test(base)) return base;
  return `${base.replace(/\s+(?:4G|5G)\b/i, '').trim()} ${variantNetwork}`;
}

function splitOfficialKey(key) {
  const capacity = storageOnly(key);
  return {
    model: key.replace(new RegExp(`\\s*${capacity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), '').trim(),
    capacity,
  };
}

function officialModelFor(record, variant, name, capacity) {
  const storageSources = [capacity, name, variant?.capacity, variant?.model, record?.ourProduct, record?.itemModel, record?.title];
  const storage = storageSources.map(storageOnly).find(isStorageValue);
  if (!storage) return null;

  const variantNetwork = inferNetwork(`${name} ${variant?.model || ''}`);
  const modelSources = [name, variant?.model, record?.ourProduct, record?.itemModel, record?.title];
  for (const source of modelSources) {
    let base = extractOfficialBase(source);
    if (!base && variantNetwork) {
      const family = extractAseriesFamily(source);
      if (family) base = `${family} ${variantNetwork}`;
    } else {
      base = applyVariantNetwork(base, variantNetwork);
    }
    if (!base) continue;
    const key = normalizeCaseModel(`${base} ${storage}`);
    if (EXCEL_SAMSUNG_MODEL_KEYS.has(key)) return splitOfficialKey(key);
  }

  return null;
}

function sanitizeVariant(variant, record) {
  if (!variant || typeof variant !== 'object') return variant;
  const name = normalizeNetworkText(normalizeStorageText(variant.name || ''));
  const parsedCapacity = storageOnly(variant.capacity || name);
  const fallbackCapacity = isStorageValue(parsedCapacity) ? parsedCapacity : '';
  const official = officialModelFor(record, variant, name, fallbackCapacity);
  return {
    ...variant,
    name,
    model: official?.model || normalizeCaseModel(normalizeModel(variant.model || '', name)),
    capacity: official?.capacity || fallbackCapacity,
    tier: inferTier(name, variant.tier),
  };
}

export function buildCloudPayload(records, maxRecords = 120) {
  const payloadRecords = [...records]
    .sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime())
    .slice(0, maxRecords)
    .map((record) => ({
      ...record,
      variants: Array.isArray(record.variants) ? record.variants.map((variant) => sanitizeVariant(variant, record)) : [],
    }));

  return { records: payloadRecords };
}

async function putJsonWithTimeout(url, payload, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function syncLatestCloudRecords(options = {}) {
  const enabled = process.env.HERMES_SYNC_CLOUD !== '0';
  if (!enabled && !options.force) return { synced: false, skipped: true, reason: 'disabled' };

  const url = options.url || process.env.D3_CLOUD_RECORDS_URL || DEFAULT_CLOUD_RECORDS_URL;
  const apiKey = options.apiKey || process.env.D3_CLOUD_API_KEY || '';
  const extraHeaders = (url.includes('jsonbin.io') && apiKey) ? { 'X-Master-Key': apiKey } : {};
  const recordsFile = options.recordsFile || process.env.D3_RECORDS_FILE || DEFAULT_RECORDS_FILE;
  const maxRecords = Number(options.maxRecords || process.env.HERMES_CLOUD_MAX_RECORDS || 120);
  const attempts = Number(options.attempts || process.env.HERMES_CLOUD_RETRY_ATTEMPTS || 3);
  const timeoutMs = Number(options.timeoutMs || process.env.HERMES_CLOUD_TIMEOUT_MS || 90000);
  const baseDelayMs = Number(options.baseDelayMs || process.env.HERMES_CLOUD_RETRY_DELAY_MS || 10000);

  const raw = fs.readFileSync(recordsFile, 'utf8');
  const records = JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error(`${recordsFile} is not a JSON array`);

  const payload = buildCloudPayload(records, Number.isFinite(maxRecords) && maxRecords > 0 ? maxRecords : 120);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await putJsonWithTimeout(url, payload, timeoutMs, extraHeaders);
      return {
        synced: true,
        url,
        records: payload.records.length,
        bytes,
        attempt,
        recordsFile,
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }

  throw new Error(`Cloud retry failed after ${attempts} attempts: ${lastError?.message || String(lastError)}`);
}

async function main() {
  loadEnvFile();
  const result = await syncLatestCloudRecords({
    recordsFile: process.argv[2] || undefined,
  });
  logHermes(`云端重试同步成功: ${result.url}（${result.records} 条，${result.bytes} bytes，第 ${result.attempt} 次）`);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logHermes(`云端重试同步失败: ${error.message || String(error)}`);
    console.error(error.message || String(error));
    process.exit(1);
  });
}
