// cdp.mjs — 连到那台已打开的真实 Chrome（CHROME_CDP_URL），attach 到对应的
// Shopee 标签页，启用 Page / Runtime / Network 域，供恢复流程检测/截图/读会话。
//
// 关键点：这是用户自己常开的 Chrome，不是我们 launch 的。所以「保持会话存活」
// 是天然的——人就在这个窗口里操作。我们只是另开一条 CDP session 旁观。

import CDP from 'chrome-remote-interface';
import { parseShopeeUrl } from '../scraper.mjs';

function parseCdpEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 9222),
    secure: parsed.protocol === 'https:',
  };
}

function matchesShopeeItemUrl(candidateUrl, ids) {
  const value = String(candidateUrl || '');
  return value.includes(`-i.${ids.shopId}.${ids.itemId}`) || value.includes(`/product/${ids.shopId}/${ids.itemId}`);
}

// 找到该商品对应的已打开标签页。找不到且 allowCreate 时后台开一个。
export async function attachToShopeeTarget({
  endpoint = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222',
  url,
  allowCreate = process.env.HERMES_CDP_ALLOW_CREATE_PAGE === '1',
} = {}) {
  const ids = parseShopeeUrl(url);
  if (!ids) throw new Error('解析不出 shopId/itemId：' + url);
  const { host, port, secure } = parseCdpEndpoint(endpoint);

  const browserClient = await CDP({ host, port, secure, target: false });
  await browserClient.Target.setDiscoverTargets({ discover: true }).catch(() => {});

  const reuseTab = process.env.HERMES_CDP_REUSE_TAB !== '0';
  const isShopeeProductUrl = (u) =>
    /shopee\.com\.my/i.test(String(u || '')) && (/-i\.\d+\.\d+/.test(u) || /product\/\d+\/\d+/.test(u));

  let targets = await CDP.List({ host, port, secure });
  let target = (targets || []).find((t) => t.type === 'page' && matchesShopeeItemUrl(t.url, ids));

  // 复用 + 清理:没精确匹配时,复用一个已存在的 Shopee 商品 tab(scraper 之后会导航过去),
  // 并关掉多余的商品 tab —— 和 scraper 共用同一个 tab,避免恢复层每个商品各开一个、且不关。
  if (!target && reuseTab) {
    const productTabs = (targets || []).filter((t) => t.type === 'page' && isShopeeProductUrl(t.url));
    if (productTabs.length) {
      target = productTabs[0];
      for (const extra of productTabs.slice(1)) {
        try { await CDP.Close({ host, port, secure, id: extra.id }); } catch { /* noop */ }
      }
    }
  }

  if (!target && allowCreate) {
    const created = await browserClient.Target.createTarget({ url, newWindow: false, background: true })
      .then((r) => ({ id: r.targetId, url }))
      .catch(async () => CDP.New({ host, port, secure, url }));
    targets = await CDP.List({ host, port, secure });
    target = (targets || []).find((t) => t.type === 'page' && matchesShopeeItemUrl(t.url, ids))
      || (targets || []).find((t) => t.type === 'page' && isShopeeProductUrl(t.url))
      || created;
  }

  if (!target) {
    await browserClient.close().catch(() => {});
    throw new Error('CDP 没找到这个商品的已打开标签页（先在 Chrome 里打开它，或设 HERMES_CDP_ALLOW_CREATE_PAGE=1）。');
  }

  const client = await CDP({ host, port, secure, target: target.id || target });
  const { Page, Runtime, Network } = client;
  await Page.enable().catch(() => {});
  await Runtime.enable().catch(() => {});
  await Network.enable().catch(() => {});

  return {
    ids,
    target,
    client,
    browserClient,
    Page,
    Runtime,
    Network,
    async close() {
      try { await client.close(); } catch { /* noop */ }
      try { await browserClient.close(); } catch { /* noop */ }
    },
  };
}
