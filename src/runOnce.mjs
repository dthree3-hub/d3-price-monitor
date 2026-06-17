import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './build-snapshot.mjs';
import { scrapeViaCrawl4AI } from './crawl4ai-shopee.mjs';
import { scrapeProduct, scrapeProductViaCDP } from './scraper.mjs';
import { scrapeViaSA } from './scraperapi.mjs';
import { parseVariantDescriptor } from './variant-parser.mjs';
import { buildListingTrace, dumpListingTrace } from './trace.mjs';
import {
  attachCompetitorMeta,
  buildHermesMarkdown,
  buildTelegramMessage,
  computeBatchChanges,
  loadEnvFile,
  loadProducts,
  logHermes,
  mergeNewRecords,
  productsFile,
  readHermesBatchState,
  selectProductsBatch,
  sendTelegramMessage,
  writeHermesBatchState,
  writeHermesStatus,
} from './lib-hermes.mjs';
import { projectRoot } from './lib-records.mjs';
import { loadSweepProducts } from './intake-products.mjs'; // Phase 2: 合并 config/product-intake.csv

const reportPath = path.join(projectRoot, 'out', 'hermes-latest.md');
const DEFAULT_CLOUD_RECORDS_URL = 'https://getpantry.cloud/apiv1/pantry/27e8f225-4039-4ec9-b2a7-cb9e324738e5/basket/d3';

function usage() {
  console.log('用法: node src/runOnce.mjs');
  console.log(`商品清单文件: ${productsFile}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSoftBlockError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('90309999') ||
    text.includes('loading issue') ||
    text.includes('page unavailable') ||
    text.includes('页面加载超时') ||
    text.includes('unexpected server response: 500')
  );
}

// 真·风控/封锁信号——只有这些才触发「连续异常就停」防封保护。
// 「页面加载超时 / 500」属瞬时问题(慢页面/网络抖动)，不算封锁 → 跳过该条继续，不会因偶发慢页面把整轮停掉。
function isHardBlockError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('90309999') ||
    text.includes('loading issue') ||
    text.includes('page unavailable') ||
    text.includes('log in to continue') ||
    text.includes('login to continue')
  );
}

function isRetriableCdpFetchError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('[cdp_fetch]') || text.includes('页面内 fetch 失败');
}

// 按款式价格算「该款最优 voucher 折扣(RM)」：在所有券里挑——
//  · 满减门槛 minSpend：只有该款价格 ≥ 门槛才算这张券（价格未知时只算无门槛券）；
//  · 折扣额：固定额取 fixed，百分比取 percent×该款价格（5%×527 ≠ 5%×999，必须逐款算）；
//  · 多张券取折扣最大的那张。
function variantVoucherAmount(price, vouchers) {
  const list = Array.isArray(vouchers) ? vouchers : [];
  const p = Number(price);
  const priceKnown = Number.isFinite(p) && p > 0;
  let best = 0;
  for (const v of list) {
    const minSpend = Number(v?.minSpend) || 0;
    if (minSpend > 0) {
      if (!priceKnown || p < minSpend) continue; // 不满足满减门槛
    }
    const fixed = Number(v?.fixed) || 0;
    const percent = Number(v?.percent) || 0;
    const pct = percent > 0 && priceKnown ? Math.round(p * (percent / 100) * 100) / 100 : 0;
    const discount = Math.max(fixed, pct);
    if (discount > best) best = discount;
  }
  return best;
}

function normalizeScrapedProduct(product, scraped) {
  const voucherFixed = toNonNegativeNumberOrZero(scraped.voucherAmount);
  const vouchers = Array.isArray(scraped.vouchers) ? scraped.vouchers : [];
  const parsedVariants = scraped.variants.map((variant) => ({
    name: variant.variant,
    ...parseVariantDescriptor(variant.variant, {
      title: scraped.title,
      itemModel: product.our_product,
      ourProduct: product.our_product,
    }),
    currentPrice: variant.current,
    originalPrice: variant.price,
    promoPrice: variant.promo_price,
    stock: variant.stock,
    inStock: !variant.sold_out,
    // 是否可买/可选(页面没灰)；scraper 未给(旧数据)时默认可买。下游写 D1 available 列。
    available: variant.available !== false,
    voucherAmount: variantVoucherAmount(variant.current, vouchers),
  }));
  const record = attachCompetitorMeta({
    schemaVersion: 1,
    grabbedAt: scraped.scrapedAt || new Date().toISOString(),
    pageUrl: product.product_url,
    shopId: scraped.shopId,
    itemId: scraped.itemId,
    sellerName: scraped.sellerName || product.competitor || '',
    title: scraped.title,
    currency: 'MYR',
    // 记录级仅保留无门槛固定额(单一数字无法表达百分比/满减)；逐款折扣放在 variant.voucherAmount。
    voucherAmount: voucherFixed,
    soldOut: Array.isArray(scraped.variants) && scraped.variants.length > 0 && scraped.variants.every((v) => v.sold_out),
    variants: parsedVariants,
  }, product);
  // Phase 1：产出可审计 trace（逐 SKU 解析+评分+价格链+完整性）dump 到 out/traces/。
  // 纯副作用：只写文件，不改 record、不碰写库/同步。HERMES_TRACE=0 可关。
  if (process.env.HERMES_TRACE !== '0') {
    try { dumpListingTrace(buildListingTrace(product, scraped, parsedVariants)); } catch {}
  }
  return record;
}

async function syncCloudRecords(records) {
  const url = process.env.D3_CLOUD_RECORDS_URL || DEFAULT_CLOUD_RECORDS_URL;
  const enabled = process.env.HERMES_SYNC_CLOUD !== '0';
  if (!enabled || !url) return { synced: false, reason: 'disabled' };
  // 方案2：同步前按 shopId:itemId 去重，只保留最新 grabbedAt 的那条。
  // 根因：recordKey 含 grabbedAt，records.json 每轮累积同一 listing 的新旧版本；都发会让旧的在 D1 覆盖新的。
  // 这里只去重「发往云端的 payload」——不改 recordKey、不动 records.json 历史、不碰 6-key/映射/重试。
  const _latestByItem = new Map();
  for (const r of records) {
    const k = `${r.shopId}:${r.itemId}`;
    const prev = _latestByItem.get(k);
    if (!prev || new Date(r.grabbedAt || 0).getTime() > new Date(prev.grabbedAt || 0).getTime()) _latestByItem.set(k, r);
  }
  const deduped = [..._latestByItem.values()];
  if (deduped.length < records.length) logHermes(`同步去重: ${records.length} → ${deduped.length} 条（按 shopId:itemId 留最新 grabbedAt）`);
  const maxRecords = Number(process.env.HERMES_CLOUD_MAX_RECORDS || 120);
  const sliced = Number.isFinite(maxRecords) && maxRecords > 0
    ? [...deduped].sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime()).slice(0, maxRecords)
    : deduped;
  // 变体价格内部字段叫 currentPrice，但 Worker /api/sync 读 v.price → 必须映射，否则价格被存成 null。
  // （sync-cloud-retry.mjs 早有此映射，runSweep 这条同步路径之前漏了。）
  const payloadRecords = sliced.map((r) => Array.isArray(r.variants)
    ? { ...r, variants: r.variants.map((v) => ({ ...v, price: v.price ?? v.currentPrice ?? v.originalPrice ?? null })) }
    : r);

  // 带重试：Cloudflare secret 改完后边缘节点会短时间不一致(间歇 401)，单试一次会丢整轮数据。
  const maxAttempts = Math.max(1, Number(process.env.HERMES_CLOUD_SYNC_RETRIES || 4));
  const body = JSON.stringify({ records: payloadRecords });
  const syncSecret = process.env.D3_CLOUD_SYNC_SECRET || '';
  const headers = {
    'Content-Type': 'application/json',
    ...(syncSecret ? { 'X-D3-Secret': syncSecret } : {}),
  };
  let lastStatus = 0;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
      });
      if (response.ok) return { synced: true, url, records: payloadRecords.length, attempts: attempt };
      lastStatus = response.status;
      const secretState = syncSecret ? `secretLen=${syncSecret.length}` : 'secret=missing';
      logHermes(`云端同步第 ${attempt}/${maxAttempts} 次失败: HTTP ${response.status} (${secretState})${attempt < maxAttempts ? '，稍后重试' : ''}`);
    } catch (error) {
      lastErr = error.message || String(error);
      logHermes(`云端同步第 ${attempt}/${maxAttempts} 次出错: ${lastErr}${attempt < maxAttempts ? '，稍后重试' : ''}`);
    }
    if (attempt < maxAttempts) await sleep(5000 * attempt); // 5s,10s,15s 退避
  }
  throw new Error(`Cloud sync failed after ${maxAttempts} attempts: HTTP ${lastStatus}${lastErr ? ` / ${lastErr}` : ''}`);
}

async function scrapeOne(product, mode) {
  if (mode === 'cdp') {
    // 开了 HERMES_RECOVERY=1：CDP 抓取被验证/登录/封锁页挡住时，自动走人工恢复流程
    // （暂停→存现场→Telegram 通知→等人工→恢复会话→重跑）。默认关闭，行为不变。
    if (process.env.HERMES_RECOVERY === '1') {
      const { guardCdpScrape } = await import('./recovery/index.mjs');
      const scraped = await guardCdpScrape(product.product_url, {
        taskContext: { competitor: product.competitor || '', ourProduct: product.our_product || '' },
      });
      return normalizeScrapedProduct(product, scraped);
    }
    const scraped = await scrapeProductViaCDP(product.product_url);
    return normalizeScrapedProduct(product, scraped);
  }

  if (mode === 'browser') {
    const scraped = await scrapeProduct(product.product_url, { headless: process.env.HEADLESS !== '0' });
    return normalizeScrapedProduct(product, scraped);
  }

  if (mode === 'crawl4ai') {
    const scraped = await scrapeViaCrawl4AI(product.product_url);
    return normalizeScrapedProduct(product, { ...scraped, scrapedAt: new Date().toISOString() });
  }

  const result = await scrapeViaSA(product.product_url);
  if (!result.ok) {
    throw new Error(result.reason || '抓取失败');
  }

  return attachCompetitorMeta({
    schemaVersion: 1,
    grabbedAt: new Date().toISOString(),
    pageUrl: product.product_url,
    shopId: result.shopId || '',
    itemId: result.itemId || '',
    sellerName: result.sellerName || product.competitor || '',
    title: result.title,
    currency: 'MYR',
    voucherAmount: 0,
    soldOut: Array.isArray(result.variants) && result.variants.length > 0 && result.variants.every((v) => v.sold_out),
    variants: result.variants.map((variant) => ({
      name: variant.variant,
      currentPrice: variant.current,
      originalPrice: variant.price,
      promoPrice: variant.promo_price,
      stock: variant.stock,
      inStock: !variant.sold_out,
      available: variant.available !== false,
    })),
  }, product);
}

function toNonNegativeNumberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function scrapeOneWithRetry(product, mode) {
  const retryDelayMs = Number(process.env.HERMES_CDP_FETCH_RETRY_DELAY_MS || 5000);

  try {
    return await scrapeOne(product, mode);
  } catch (error) {
    if (mode !== 'cdp' || !isRetriableCdpFetchError(error)) {
      throw error;
    }

    logHermes(`页面内 fetch 失败，${retryDelayMs}ms 后重试一次: ${product.competitor || '-'} | ${product.product_url}`);
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
    return scrapeOne(product, mode);
  }
}

export async function runOnce() {
  loadEnvFile();
  const startedAt = new Date().toISOString();
  const mode = process.env.HERMES_SCRAPE_MODE || 'scraperapi';
  const itemDelayMs = Number(process.env.HERMES_ITEM_DELAY_MS || 2500);
  const abortSoftBlocks = Number(process.env.HERMES_ABORT_AFTER_SOFTBLOCKS || 2);
  const allProducts = loadSweepProducts(loadProducts(), { log: logHermes }); // base + product-intake.csv
  if (!allProducts.length) {
    usage();
    throw new Error(`没有可抓取的商品。先编辑 ${productsFile}`);
  }
  const batchSize = Number(process.env.HERMES_BATCH_SIZE || 5);
  const batchInfo = selectProductsBatch(allProducts, batchSize);
  const products = batchInfo.batch;
  logHermes(`本轮批次: 第 ${batchInfo.batchNumber} 批，抓 ${products.length}/${batchInfo.total} 条，cursor=${batchInfo.cursor} -> ${batchInfo.nextCursor}`);

  const incoming = [];
  const failures = [];
  let consecutiveSoftBlocks = 0;
  for (const product of products) {
    try {
      logHermes(`开始抓取: ${product.competitor || '-'} | ${product.product_url}`);
      const record = await scrapeOneWithRetry(product, mode);
      incoming.push(record);
      consecutiveSoftBlocks = 0;
      logHermes(`抓取成功: ${product.competitor || '-'} | ${record.title}`);
    } catch (error) {
      const message = `${product.competitor || '-'} | ${product.product_url} | ${error.message || String(error)}`;
      failures.push(message);
      logHermes(`抓取失败: ${message}`);
      if (isHardBlockError(error)) {
        consecutiveSoftBlocks += 1;
        logHermes(`连续风控/封锁计数: ${consecutiveSoftBlocks}/${abortSoftBlocks}`);
        if (consecutiveSoftBlocks >= abortSoftBlocks) {
          logHermes('本轮提前结束：连续 Shopee 风控/封锁(90309999/要登录)，停止本轮防封，等待下轮恢复。');
          break;
        }
      }
      // 页面加载超时 / 500 等瞬时失败：跳过该条继续，不计入停止阈值（不因偶发慢页面停掉整轮）。
    }

    if (itemDelayMs > 0) {
      await sleep(itemDelayMs);
    }
  }

  const latestTimestamp = incoming[0]?.grabbedAt || null;
  // 抓到新记录就前进；一条都没抓到(可能被反爬拦)最多重试 2 次，超过就跳过这批，
  // 避免单批被拦死循环、冻结整个轮换。
  const MAX_BATCH_RETRIES = 2;
  const prevRetries = Number(readHermesBatchState().retries) || 0;
  const shouldAdvanceBatchCursor = incoming.length > 0 || prevRetries >= MAX_BATCH_RETRIES;
  const { before, merged } = mergeNewRecords(incoming, allProducts);
  const changes = latestTimestamp ? computeBatchChanges(before, merged, latestTimestamp) : [];
  const markdown = buildHermesMarkdown(changes, latestTimestamp, incoming.length);
  const dashboardPath = buildSnapshot();

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown);

  if (failures.length) {
    const body = ['# 抓取失败', '', ...failures.map((line) => `- ${line}`), ''].join('\n');
    fs.appendFileSync(reportPath, `\n${body}`);
  }

  const notify = process.env.HERMES_NOTIFY !== '0';
  if (notify) {
    const message = buildTelegramMessage(changes);
    await sendTelegramMessage(message);
  }

  try {
    const cloud = await syncCloudRecords(merged);
    if (cloud.synced) {
      logHermes(`云端数据已同步: ${cloud.url}（${cloud.records} 条最新记录）`);
    }
  } catch (error) {
    logHermes(`云端同步失败: ${error.message || String(error)}`);
  }

  if (shouldAdvanceBatchCursor) {
    if (incoming.length === 0) {
      logHermes(`本批重试 ${prevRetries} 次仍 0 条（可能被反爬拦），跳过该批，cursor 前进到 ${batchInfo.nextCursor}。`);
    }
    writeHermesBatchState({ cursor: batchInfo.nextCursor, retries: 0 });
  } else {
    writeHermesBatchState({ cursor: batchInfo.cursor, retries: prevRetries + 1 });
    logHermes(`本轮未抓到新记录，保留 batch cursor=${batchInfo.cursor}（第 ${prevRetries + 1}/${MAX_BATCH_RETRIES} 次重试），下次重跑当前批次。`);
  }

  writeHermesStatus({
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    products: products.length,
    totalProducts: allProducts.length,
    batchSize: batchInfo.batchSize,
    batchNumber: batchInfo.batchNumber,
    batchCursor: batchInfo.cursor,
    nextBatchCursor: batchInfo.nextCursor,
    scraped: incoming.length,
    latestTimestamp,
    changed: changes.filter((change) => change.status !== 'same').length,
    failuresCount: failures.length,
    failures,
    changes: changes.filter((change) => change.status !== 'same').slice(0, 50),
    reportPath,
    dashboardPath,
  });

  return {
    mode,
    products: products.length,
    totalProducts: allProducts.length,
    batchSize: batchInfo.batchSize,
    batchNumber: batchInfo.batchNumber,
    batchCursor: batchInfo.cursor,
    nextBatchCursor: batchInfo.nextCursor,
    scraped: incoming.length,
    latestTimestamp,
    changes,
    failures,
    reportPath,
    dashboardPath,
  };
}

// ── 整组慢速 sweep（防封新模型）──────────────────────────────────────────────
// 一次把某一组(self / competitor / all)的所有商品抓完，跨店轮流 + 随机延迟，
// 不用 batch cursor。比 runOnce 的「每轮一批」更适合「一天定时跑几整圈」的节奏。
function shopIdOf(url) {
  const m = String(url || '').match(/i\.(\d+)\.\d+/);
  return m ? m[1] : '';
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 按店分组、各店内部打乱、再跨店轮流取（避免连续猛打同一家店）。
function interleaveByShop(products) {
  const byShop = new Map();
  for (const p of products) {
    const sid = shopIdOf(p.product_url) || 'unknown';
    if (!byShop.has(sid)) byShop.set(sid, []);
    byShop.get(sid).push(p);
  }
  const lists = [...byShop.values()].map((arr) => shuffleInPlace(arr));
  const out = [];
  const maxLen = Math.max(0, ...lists.map((a) => a.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const arr of lists) {
      if (i < arr.length) out.push(arr[i]);
    }
  }
  return out;
}

// group: 'competitor'（默认，排除自家店）| 'self'（只自家店）| 'all'（全部）
export async function runSweep({ group = 'competitor', reason = '' } = {}) {
  loadEnvFile();
  const startedAt = new Date().toISOString();
  const mode = process.env.HERMES_SCRAPE_MODE || 'cdp';
  const minMs = Number(process.env.HERMES_ITEM_DELAY_MIN_MS || 10000);
  const maxMs = Number(process.env.HERMES_ITEM_DELAY_MAX_MS || 20000);
  const abortSoftBlocks = Number(process.env.HERMES_ABORT_AFTER_SOFTBLOCKS || 2);
  const selfShop = String(process.env.HERMES_SELF_SHOP_ID || '54618012');

  const all = loadSweepProducts(loadProducts(), { log: logHermes }); // base + product-intake.csv
  if (!all.length) {
    usage();
    throw new Error(`没有可抓取的商品。先编辑 ${productsFile}`);
  }

  let selected = all;
  if (group === 'self') selected = all.filter((p) => shopIdOf(p.product_url) === selfShop);
  else if (group === 'competitor') selected = all.filter((p) => shopIdOf(p.product_url) !== selfShop);
  selected = interleaveByShop(selected);

  logHermes(`[sweep] 开始 组=${group}${reason ? `(${reason})` : ''}，共 ${selected.length} 条，模式=${mode}，每条随机间隔 ${minMs}-${maxMs}ms`);

  const incoming = [];
  const failures = [];
  let consecutiveSoftBlocks = 0;
  let aborted = false;

  for (const product of selected) {
    try {
      const record = await scrapeOneWithRetry(product, mode);
      incoming.push(record);
      consecutiveSoftBlocks = 0;
    } catch (error) {
      const message = `${product.competitor || '-'} | ${product.product_url} | ${error.message || String(error)}`;
      failures.push(message);
      logHermes(`抓取失败: ${message}`);
      // 碰到验证、你在限定时间内没解（或主动中止）→ 立即停整轮，不继续抓（你要的）。
      if (error?.name === 'VerificationTimeoutError' || error?.name === 'VerificationAbortedError') {
        aborted = true;
        logHermes(`碰到验证你没在限时内解（${error.name}），停止本轮。下一轮或手动按钮再抓。`);
        break;
      }
      // 只有真·风控/封锁(90309999/要登录/page unavailable)才触发「连续 N 停」防封；
      // 页面加载超时/500 等瞬时失败 → 跳过该条继续，不因偶发慢页面把整轮停掉。
      if (isHardBlockError(error)) {
        consecutiveSoftBlocks += 1;
        logHermes(`连续风控/封锁计数: ${consecutiveSoftBlocks}/${abortSoftBlocks}`);
        if (consecutiveSoftBlocks >= abortSoftBlocks) {
          aborted = true;
          logHermes('本轮提前结束：连续 Shopee 风控/封锁，停止本轮，等待下一轮/手动触发。');
          break;
        }
      }
    }
    // 随机延迟（防封关键：节奏不规律 + 慢）
    const delay = minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs));
    if (delay > 0) await sleep(delay);
  }

  const latestTimestamp = incoming[0]?.grabbedAt || null;
  const { before, merged } = mergeNewRecords(incoming, all);
  const changes = latestTimestamp ? computeBatchChanges(before, merged, latestTimestamp) : [];
  const markdown = buildHermesMarkdown(changes, latestTimestamp, incoming.length);
  const dashboardPath = buildSnapshot();

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown);
  if (failures.length) {
    const body = ['# 抓取失败', '', ...failures.map((line) => `- ${line}`), ''].join('\n');
    fs.appendFileSync(reportPath, `\n${body}`);
  }

  if (process.env.HERMES_NOTIFY !== '0') {
    await sendTelegramMessage(buildTelegramMessage(changes));
  }

  let cloudSync = { ok: false, info: '' };
  try {
    const cloud = await syncCloudRecords(merged);
    if (cloud.synced) {
      cloudSync = { ok: true, info: `${cloud.records} 条` };
      logHermes(`云端数据已同步: ${cloud.url}（${cloud.records} 条最新记录）`);
    } else {
      cloudSync = { ok: false, info: cloud.reason || '未同步' };
    }
  } catch (error) {
    cloudSync = { ok: false, info: error.message || String(error) };
    logHermes(`云端同步失败: ${error.message || String(error)}`);
  }

  writeHermesStatus({
    startedAt,
    finishedAt: new Date().toISOString(),
    mode,
    group,
    products: selected.length,
    totalProducts: all.length,
    scraped: incoming.length,
    latestTimestamp,
    changed: changes.filter((c) => c.status !== 'same').length,
    failuresCount: failures.length,
    failures,
    aborted,
    reportPath,
    dashboardPath,
  });

  logHermes(`[sweep] 完成 组=${group}，抓 ${incoming.length}/${selected.length} 条，失败 ${failures.length}${aborted ? '（因风控提前停止）' : ''}`);
  return { group, products: selected.length, scraped: incoming.length, failures, changes, aborted, latestTimestamp, cloudSync };
}

function canonicalizeEntryPath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native
      ? fs.realpathSync.native(resolved)
      : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sameEntryPath(left, right) {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

const isDirectRun = Boolean(process.argv[1]) && sameEntryPath(
  canonicalizeEntryPath(fileURLToPath(import.meta.url)),
  canonicalizeEntryPath(process.argv[1]),
);

if (isDirectRun) {
  runOnce()
    .then((result) => {
      console.log(`Hermes 完成: ${result.scraped}/${result.products} 个商品抓取成功`);
      console.log(`报告: ${result.reportPath}`);
      console.log(`Dashboard: ${result.dashboardPath}`);
      console.log(`变化条数: ${result.changes.filter((change) => change.status !== 'same').length}`);
      if (result.failures.length) {
        console.log('失败:');
        for (const failure of result.failures) console.log(`- ${failure}`);
      }
    })
    .catch((error) => {
      console.error(`Hermes 失败: ${error.message || String(error)}`);
      process.exit(1);
    });
}
