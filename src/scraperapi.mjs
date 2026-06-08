// 通过 ScraperAPI 抓虾皮（它负责住宅IP+反爬，我们只管要数据）。
// 策略：直接打虾皮的价格 JSON 接口 get_pc（最省 credits、数据最干净），
//       先用 premium 档，失败再升级 ultra_premium 档重试一次。

import { parseShopeeUrl, extractFromPdp } from './scraper.mjs';

const ENDPOINT = 'https://api.scraperapi.com/';

function key() {
  const k = process.env.SCRAPERAPI_KEY;
  if (!k) throw new Error('没设 SCRAPERAPI_KEY（在 .env 里填）');
  return k;
}

// 调一次 ScraperAPI。tier: 'premium' | 'ultra'
export async function saFetch(targetUrl, tier = 'premium', country = 'my') {
  const p = new URLSearchParams({ api_key: key(), url: targetUrl, country_code: country });
  if (tier === 'premium') p.set('premium', 'true');
  if (tier === 'ultra') p.set('ultra_premium', 'true');
  const res = await fetch(`${ENDPOINT}?${p.toString()}`);
  const body = await res.text();
  // ScraperAPI 把这次消耗的 credits 放在响应头
  const costHeader = res.headers.get('sa-credit-cost') ?? res.headers.get('x-sa-credit-cost');
  return { status: res.status, body, cost: costHeader ? Number(costHeader) : null };
}

// 查账户余额/已用量（用来精确算 credits）
export async function saAccount() {
  const res = await fetch(`https://api.scraperapi.com/account?api_key=${key()}`);
  if (!res.ok) throw new Error('查账户失败 ' + res.status);
  return res.json(); // { requestCount, requestLimit, concurrencyLimit, ... }
}

// 抓一个虾皮商品页的所有款式价格（走 ScraperAPI）
export async function scrapeViaSA(productUrl) {
  const ids = parseShopeeUrl(productUrl);
  if (!ids) return { ok: false, reason: 'URL 解析不出 shopId/itemId' };

  const apiUrl = `https://shopee.com.my/api/v4/pdp/get_pc?item_id=${ids.itemId}&shop_id=${ids.shopId}`;
  const attempts = [];

  for (const tier of ['premium', 'ultra']) {
    const r = await saFetch(apiUrl, tier);
    let json = null;
    try { json = JSON.parse(r.body); } catch {}

    const note = { tier, status: r.status, cost: r.cost };
    if (!json) { attempts.push({ ...note, reason: '非JSON(可能被挡/返回HTML)' }); continue; }
    if (json.error && json.error !== 0) { attempts.push({ ...note, reason: '虾皮反爬码 ' + json.error }); continue; }

    const data = extractFromPdp(json);
    if (!data || !data.variants?.length) { attempts.push({ ...note, reason: '无款式数据' }); continue; }

    return { ok: true, tier, status: r.status, cost: r.cost, attempts, shopId: ids.shopId, itemId: ids.itemId, ...data };
  }

  return { ok: false, reason: attempts.map(a => `${a.tier}:${a.reason}`).join(' / '), attempts };
}
