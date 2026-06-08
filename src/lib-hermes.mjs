import fs from 'node:fs';
import path from 'node:path';
import {
  buildChangeReport,
  mergeRecords,
  projectRoot,
  readRecords,
  writeRecords,
} from './lib-records.mjs';

export const productsFile = path.join(projectRoot, 'config', 'products.csv');
export const hermesLogFile = path.join(projectRoot, 'out', 'hermes.log');
export const hermesStatusFile = path.join(projectRoot, 'out', 'hermes-status.json');
export const telegramOffsetFile = path.join(projectRoot, 'out', 'telegram-offset.json');
export const hermesBatchStateFile = path.join(projectRoot, 'out', 'hermes-batch-state.json');

export function loadEnvFile(file = path.join(projectRoot, '.env')) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

export function ensureProductsFile() {
  if (fs.existsSync(productsFile)) return;
  const example = path.join(projectRoot, 'config', 'products.example.csv');
  fs.mkdirSync(path.dirname(productsFile), { recursive: true });
  fs.copyFileSync(example, productsFile);
}

export function parseCsv(text) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

export function loadProducts() {
  ensureProductsFile();
  const raw = fs.readFileSync(productsFile, 'utf8');
  const rows = parseCsv(raw);
  if (!rows.length) return [];

  const header = rows[0].map((cell) => cell.trim());
  return rows.slice(1)
    .filter((row) => row.some((cell) => String(cell || '').trim()))
    .map((row) => Object.fromEntries(header.map((key, index) => [key, String(row[index] || '').trim()])))
    .filter((row) => row.product_url && (!row.status || row.status === 'active'));
}

export function readHermesBatchState() {
  if (!fs.existsSync(hermesBatchStateFile)) return { cursor: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(hermesBatchStateFile, 'utf8'));
    return {
      cursor: Number.isFinite(Number(parsed.cursor)) ? Number(parsed.cursor) : 0,
    };
  } catch {
    return { cursor: 0 };
  }
}

export function writeHermesBatchState(state) {
  fs.mkdirSync(path.dirname(hermesBatchStateFile), { recursive: true });
  fs.writeFileSync(hermesBatchStateFile, `${JSON.stringify({
    cursor: Number.isFinite(Number(state?.cursor)) ? Number(state.cursor) : 0,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

export function selectProductsBatch(products, batchSize = 5) {
  const total = Array.isArray(products) ? products.length : 0;
  if (!total) {
    return {
      total: 0,
      batchSize: 0,
      cursor: 0,
      nextCursor: 0,
      batchNumber: 0,
      batch: [],
    };
  }

  const normalizedSize = Number.isFinite(Number(batchSize)) && Number(batchSize) > 0
    ? Math.min(total, Math.max(1, Number(batchSize)))
    : Math.min(total, 5);

  const { cursor: rawCursor } = readHermesBatchState();
  const cursor = ((rawCursor % total) + total) % total;
  const remaining = total - cursor;
  const actualBatchSize = Math.min(normalizedSize, remaining);
  const batch = products.slice(cursor, cursor + actualBatchSize);
  const nextCursor = cursor + actualBatchSize >= total ? 0 : cursor + actualBatchSize;
  const batchNumber = Math.floor(cursor / normalizedSize) + 1;

  return {
    total,
    batchSize: normalizedSize,
    cursor,
    nextCursor,
    batchNumber,
    batch,
  };
}

export function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function appendProduct(product) {
  ensureProductsFile();
  const line = [
    product.our_product || '',
    product.our_price || '',
    product.competitor || '',
    product.store_url || '',
    product.keyword || '',
    product.product_url || '',
    product.variant || '',
    product.status || 'active',
    product.last_confirmed || new Date().toISOString().slice(0, 10),
  ].map(csvEscape).join(',');

  fs.appendFileSync(productsFile, `${line}\n`);
}

export function hasProductUrl(url) {
  return loadProducts().some((product) => product.product_url === String(url).trim());
}

export function parseProductUrlIds(url) {
  const value = String(url || '');
  let match = value.match(/-i\.(\d+)\.(\d+)/);
  if (match) return { shopId: match[1], itemId: match[2] };
  match = value.match(/product\/(\d+)\/(\d+)/);
  if (match) return { shopId: match[1], itemId: match[2] };
  return null;
}

export function activeWatchlistKeys(products = loadProducts()) {
  return new Set(
    products
      .map((product) => parseProductUrlIds(product.product_url))
      .filter(Boolean)
      .map((ids) => `${ids.shopId}:${ids.itemId}`)
  );
}

export function attachCompetitorMeta(record, product) {
  if (!product) return record;
  return {
    ...record,
    sellerName: product.competitor || record.sellerName || '',
    sourceSellerName: record.sellerName || '',
    competitor: product.competitor || '',
    ourProduct: product.our_product || '',
    ourPrice: product.our_price || '',
  };
}

export function computeBatchChanges(beforeRecords, afterRecords, latestTimestamp) {
  const latestKeys = new Set(
    afterRecords
      .filter((record) => record.grabbedAt === latestTimestamp)
      .flatMap((record) => record.variants.map((variant) => `${record.shopId}:${record.itemId}:${variant.name}`))
  );

  return buildChangeReport(afterRecords).filter((change) =>
    latestKeys.has(`${change.shopId}:${change.itemId}:${change.variantName}`)
  );
}

export function mergeNewRecords(incoming, products = loadProducts()) {
  const allowedKeys = activeWatchlistKeys(products);
  const before = readRecords().filter((record) => allowedKeys.has(`${record.shopId}:${record.itemId}`));
  const merged = mergeRecords(before, incoming);
  writeRecords(merged);
  return { before, merged };
}

export function formatRm(value) {
  return value == null ? 'N/A' : `RM${value}`;
}

export function formatChangeLine(change) {
  if (change.status === 'up') {
    return `${formatRm(change.previousPrice)} -> ${formatRm(change.currentPrice)} (涨 ${formatRm(change.delta)})`;
  }
  if (change.status === 'down') {
    return `${formatRm(change.previousPrice)} -> ${formatRm(change.currentPrice)} (降 ${formatRm(Math.abs(change.delta))})`;
  }
  if (change.status === 'sold_out') {
    return `${formatRm(change.currentPrice)} (变为缺货)`;
  }
  if (change.status === 'restocked') {
    return `${formatRm(change.currentPrice)} (重新有货)`;
  }
  if (change.status === 'new') {
    return `${formatRm(change.currentPrice)} (首次记录)`;
  }
  return `${formatRm(change.currentPrice)} (无变化)`;
}

export function buildHermesMarkdown(changes, latestTimestamp, scrapedCount) {
  const lines = [
    '# Hermes Price Check',
    '',
    `- 生成时间: ${new Date().toISOString()}`,
    `- 本次抓取批次: ${latestTimestamp || '无'}`,
    `- 本次抓取商品数: ${scrapedCount}`,
    `- 变价/状态变化条数: ${changes.filter((change) => change.status !== 'same').length}`,
    '',
  ];

  if (!changes.length) {
    lines.push('本次没有抓到任何新记录。');
    return `${lines.join('\n')}\n`;
  }

  const important = changes.filter((change) => change.status !== 'same');
  if (!important.length) {
    lines.push('本次抓到新批次，但没有发现价格或库存变化。');
    return `${lines.join('\n')}\n`;
  }

  for (const change of important) {
    lines.push(`## ${change.title}`);
    lines.push(`- 对手: ${change.sellerName || change.shopId}`);
    lines.push(`- 款式: ${change.variantName}`);
    lines.push(`- 变化: ${formatChangeLine(change)}`);
    lines.push(`- 对比: ${change.previousGrabbedAt || '无历史'} -> ${change.grabbedAt}`);
    lines.push(`- 链接: ${change.pageUrl}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${response.status}: ${body}`);
  }

  return response.json();
}

export function buildTelegramMessage(changes) {
  const important = changes.filter((change) => change.status !== 'same');
  if (!important.length) return 'Hermes: 本次检查没有发现对手变价。';

  const lines = ['Hermes 发现对手价格/库存变化：'];
  for (const change of important.slice(0, 15)) {
    lines.push(`- ${change.sellerName || change.shopId} | ${change.variantName} | ${formatChangeLine(change)}`);
  }
  if (important.length > 15) {
    lines.push(`- 其余 ${important.length - 15} 条变化请看本地报告`);
  }
  return lines.join('\n');
}

export function logHermes(message) {
  fs.mkdirSync(path.dirname(hermesLogFile), { recursive: true });
  fs.appendFileSync(hermesLogFile, `[${new Date().toISOString()}] ${message}\n`);
}

export function writeHermesStatus(status) {
  fs.mkdirSync(path.dirname(hermesStatusFile), { recursive: true });
  fs.writeFileSync(hermesStatusFile, `${JSON.stringify(status, null, 2)}\n`);
}

export function readHermesStatus() {
  if (!fs.existsSync(hermesStatusFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(hermesStatusFile, 'utf8'));
  } catch {
    return null;
  }
}

export function readTelegramOffset() {
  if (!fs.existsSync(telegramOffsetFile)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(telegramOffsetFile, 'utf8'));
    return Number(parsed.update_id || 0);
  } catch {
    return 0;
  }
}

export function writeTelegramOffset(updateId) {
  fs.mkdirSync(path.dirname(telegramOffsetFile), { recursive: true });
  fs.writeFileSync(telegramOffsetFile, `${JSON.stringify({ update_id: updateId }, null, 2)}\n`);
}

export async function telegramApi(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('缺少 TELEGRAM_BOT_TOKEN');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${method} ${response.status}: ${body}`);
  }
  return response.json();
}

export async function getTelegramUpdates(offset = 0, timeout = 20) {
  return telegramApi('getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message'],
  });
}

export async function sendTelegramReply(chatId, text) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

export function buildStatusMessage() {
  const status = readHermesStatus();
  if (!status) return '我这边还没有运行记录。你可以叫我现在检查一次，或者直接发 /run。';

  const lines = [
    '这是我目前的监控状态：',
    `- 上次运行: ${status.finishedAt || status.startedAt || '未知'}`,
    `- 抓取模式: ${status.mode || '未知'}`,
    `- 商品数: ${status.products ?? 0}`,
    `- 成功: ${status.scraped ?? 0}`,
    `- 变化: ${status.changed ?? 0}`,
    `- 失败: ${status.failuresCount ?? 0}`,
  ];
  return lines.join('\n');
}

export function buildChangesMessage(limit = 10) {
  const status = readHermesStatus();
  if (!status?.changes?.length) return '最近一次检查没有发现价格或库存变化。';

  const lines = ['最近一次检测到的变化：'];
  for (const change of status.changes.slice(0, limit)) {
    lines.push(`- ${change.sellerName || change.shopId} | ${change.variantName} | ${formatChangeLine(change)}`);
  }
  if (status.changes.length > limit) {
    lines.push(`- 其余 ${status.changes.length - limit} 条变化请看 dashboard`);
  }
  return lines.join('\n');
}

export function buildWatchlistMessage(limit = 20) {
  const products = loadProducts();
  if (!products.length) return '我这边还没有监控商品。你把 Shopee 商品链接发我，我可以帮你加进去。';

  const lines = ['我现在在监控这些商品：'];
  for (const product of products.slice(0, limit)) {
    lines.push(`- ${product.competitor || '未命名对手'} | ${product.our_product || product.keyword || '未命名商品'}`);
  }
  if (products.length > limit) {
    lines.push(`- 其余 ${products.length - limit} 条请看 products.csv`);
  }
  return lines.join('\n');
}

export function buildHelpMessage() {
  return [
    '我是你的 Shopee 价格监控助理。',
    '我可以帮你看状态、查最近变价、立刻跑一轮检查，也可以把新的商品加进监控名单。',
    '',
    '常用命令：',
    '/status - 看上次运行状态',
    '/changes - 看最近一次变价',
    '/watchlist - 看当前监控名单',
    '/run - 立刻跑一轮抓价',
    '/add 对手名 商品链接 - 新增监控商品',
    '/help - 查看帮助',
    '',
    '你也可以直接跟我说人话，例如：',
    '- 帮我跑价格',
    '- 最近谁改价了',
    '- 现在监控什么',
    '- 帮我加 Spray Gadget https://shopee.com.my/...',
  ].join('\n');
}

export function buildRunResultMessage(result) {
  const changed = Array.isArray(result?.changes)
    ? result.changes.filter((change) => change.status !== 'same').length
    : 0;
  const failed = Array.isArray(result?.failures) ? result.failures.length : 0;
  return `这一轮检查已经完成：成功 ${result?.scraped ?? 0}/${result?.products ?? 0}，发现变化 ${changed} 条，失败 ${failed} 条。`;
}
