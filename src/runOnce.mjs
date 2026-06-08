import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from './build-snapshot.mjs';
import { scrapeProduct, scrapeProductViaCDP } from './scraper.mjs';
import { scrapeViaSA } from './scraperapi.mjs';
import { parseVariantDescriptor } from './variant-parser.mjs';
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
  selectProductsBatch,
  sendTelegramMessage,
  writeHermesBatchState,
  writeHermesStatus,
} from './lib-hermes.mjs';
import { projectRoot } from './lib-records.mjs';

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

function isRetriableCdpFetchError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('[cdp_fetch]') || text.includes('页面内 fetch 失败');
}

function normalizeScrapedProduct(product, scraped) {
  return attachCompetitorMeta({
    schemaVersion: 1,
    grabbedAt: scraped.scrapedAt || new Date().toISOString(),
    pageUrl: product.product_url,
    shopId: scraped.shopId,
    itemId: scraped.itemId,
    sellerName: scraped.sellerName || product.competitor || '',
    title: scraped.title,
    currency: 'MYR',
    variants: scraped.variants.map((variant) => ({
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
    })),
  }, product);
}

async function syncCloudRecords(records) {
  const url = process.env.D3_CLOUD_RECORDS_URL || DEFAULT_CLOUD_RECORDS_URL;
  const enabled = process.env.HERMES_SYNC_CLOUD !== '0';
  if (!enabled || !url) return { synced: false, reason: 'disabled' };
  const maxRecords = Number(process.env.HERMES_CLOUD_MAX_RECORDS || 120);
  const payloadRecords = Number.isFinite(maxRecords) && maxRecords > 0
    ? [...records].sort((a, b) => new Date(b.grabbedAt).getTime() - new Date(a.grabbedAt).getTime()).slice(0, maxRecords)
    : records;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: payloadRecords }),
  });
  if (!response.ok) {
    throw new Error(`Cloud sync failed: HTTP ${response.status}`);
  }
  return { synced: true, url, records: payloadRecords.length };
}

async function scrapeOne(product, mode) {
  if (mode === 'cdp') {
    const scraped = await scrapeProductViaCDP(product.product_url);
    return normalizeScrapedProduct(product, scraped);
  }

  if (mode === 'browser') {
    const scraped = await scrapeProduct(product.product_url, { headless: process.env.HEADLESS !== '0' });
    return normalizeScrapedProduct(product, scraped);
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
    variants: result.variants.map((variant) => ({
      name: variant.variant,
      currentPrice: variant.current,
      originalPrice: variant.price,
      promoPrice: variant.promo_price,
      stock: variant.stock,
      inStock: !variant.sold_out,
    })),
  }, product);
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
  const allProducts = loadProducts();
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
      if (isSoftBlockError(error)) {
        consecutiveSoftBlocks += 1;
        logHermes(`连续风控/页面异常计数: ${consecutiveSoftBlocks}/${abortSoftBlocks}`);
        if (consecutiveSoftBlocks >= abortSoftBlocks) {
          logHermes('本轮提前结束：连续出现 Shopee 风控/页面异常，停止继续抓取，等待下轮恢复。');
          break;
        }
      } else {
        consecutiveSoftBlocks = 0;
      }
    }

    if (itemDelayMs > 0) {
      await sleep(itemDelayMs);
    }
  }

  const latestTimestamp = incoming[0]?.grabbedAt || null;
  const shouldAdvanceBatchCursor = incoming.length > 0;
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
    writeHermesBatchState({ cursor: batchInfo.nextCursor });
  } else {
    logHermes(`本轮未抓到新记录，保留 batch cursor=${batchInfo.cursor}，下次继续重跑当前批次。`);
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
