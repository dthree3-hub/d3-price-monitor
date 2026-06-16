// 抓单个虾皮马来西亚商品链接里的「所有款式价格」。
// 用法：node src/scraper.mjs "<商品链接>"
//
// 思路：用真实浏览器（Playwright）打开商品页，拦截页面自己发出的
// 商品详情接口（/api/v4/pdp/...）响应，里面带着每个款式(model)的价格。
// 这样不用我们手动伪造反爬请求头，最不容易被挡。价格字段是「微元」(price/100000)。

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import CDP from 'chrome-remote-interface';
import fs from 'node:fs';
import { URL } from 'node:url';

chromium.use(stealth()); // 隐藏「自动化浏览器」指纹，绕虾皮反爬

const STATE_FILE = 'out/shopee-state.json'; // 存 cookie，下次不再弹语言页

// 虾皮给新会话弹「Select Your Language」拦路页，挡住商品页 → 点 English 真正过掉
async function dismissLanguageGate(page, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const en = page.getByText('English', { exact: true });
    const onGate = await en.isVisible({ timeout: 3000 }).catch(() => false);
    if (!onGate) return true; // 没门了，过了
    await en.click().catch(() => {});
    await page.waitForTimeout(3000); // 等它跳转/设 cookie
    // 点完若不在商品页，手动回商品页
    if (!page.url().includes('-i.')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    }
  }
  return false; // 三次还过不去
}

const RM = (micros) => (micros == null || micros < 0 ? null : micros / 100000);

// 从虾皮链接里抠出 shopId / itemId
// 支持两种格式：
//   .../name-i.<shopId>.<itemId>
//   .../product/<shopId>/<itemId>
export function parseShopeeUrl(url) {
  let m = url.match(/-i\.(\d+)\.(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };
  m = url.match(/product\/(\d+)\/(\d+)/);
  if (m) return { shopId: m[1], itemId: m[2] };
  return null;
}

// 从拦截到的 PDP 接口数据里，整理出款式列表
export function extractFromPdp(json) {
  if (json?.error && json.error !== 0) {
    throw new Error(`Shopee 接口错误码 ${json.error}`);
  }
  const item = json?.data?.item ?? json?.item ?? json?.data;
  if (!item) return null;

  const title = item.title ?? item.name ?? '(无标题)';
  const sellerName = item.shop_name ?? item.shopid ?? '';
  const tiers = item.tier_variations ?? [];
  const models = item.models ?? [];

  // 灰掉/不可选(disabled)的 variant 不再丢弃，而是保留并标记 available=false：Shopee PDP 的
  // is_grayout=true / is_clickable=false 表示该组合在页面上灰色、不能购买(如停产的 Flip 7 FE 颜色)。
  // available=true 的条件：不是 is_grayout，且 is_clickable 不是 false。严格判断——字段缺失(undefined)
  // 视为可买(available=true)，避免像 A06 那种 is_grayout 恒 false / 字段缺失的 listing 误伤。
  // 保留全部 variant 是为了让下游能判断「整个 capacity/model 全灰」→ 前端显示 Not Available；
  // 单颜色灰仍可被前端忽略。验证数据见 out/pdp-raw.json(Fold 7：灰款 grayout=true)。
  const isDisabledModel = (mdl) => mdl.is_grayout === true || mdl.is_clickable === false;
  const disabledCount = models.filter(isDisabledModel).length;
  if (disabledCount) console.error(`[scraper] 保留 ${disabledCount} 个灰掉/不可选 variant 并标记 available=false(${title})`);

  // 每个 model 的 extinfo.tier_index 指向各 tier 的第几个选项，拼成款式名
  const variants = models.map((mdl) => {
    // 从所有 tier 维度重建完整款式名。Shopee 的多维变体(如「Set Package」×「Model+Color」)里，
    // mdl.name 常只含一维(如 "Set A")，会丢掉型号/容量/颜色/网络那一维 → 必须按 tier_index 拼全维度。
    const dims = (tiers.length && Array.isArray(mdl.extinfo?.tier_index))
      ? mdl.extinfo.tier_index.map((optIdx, tierIdx) => tiers[tierIdx]?.options?.[optIdx]).filter(Boolean)
      : [];
    let label = mdl.name || '';
    // 多维(≥2 维)时一定用重建(mdl.name 丢维度)；mdl.name 为空时也用重建；单维则保留 mdl.name(不回归)。
    if (dims.length && (dims.length >= 2 || !label)) label = dims.join(' / ');
    const price = RM(mdl.price);
    const promo = RM(mdl.promotion_price);
    return {
      variant: label || '(默认)',
      price,                         // 标价
      promo_price: promo,            // 促销价（有就是它更便宜）
      current: promo ?? price,       // 现在实际显示的价
      stock: mdl.stock ?? mdl.normal_stock,
      // 售罄判断：Shopee 的 mdl.stock 常为 null，真正可靠的是 has_stock(布尔)。
      // 严格 === false，避免字段缺失(undefined)时把全部误判成售罄。
      sold_out: mdl.has_stock === false || mdl.stock === 0,
      // 是否可买/可选：false=页面灰掉(is_grayout / is_clickable===false)。下游据此判断
      // 「整 capacity / 整 model 全灰」→ 前端显示 Not Available。字段缺失视为可买。
      available: !isDisabledModel(mdl),
      // ── trace 原始字段（Phase 1 仅用于 out/traces，不参与写库/同步）──
      _raw: {
        modelName: mdl.name || '',
        dims,                                       // tier_index 拼出的各维度选项
        tierCount: tiers.length,
        hasStock: mdl.has_stock,
        normalStock: mdl.normal_stock,
        rawStock: mdl.stock,
        priceBeforeDiscount: RM(mdl.price_before_discount),
        modelId: mdl.model_id,
        status: mdl.status,
        isGrayout: mdl.is_grayout,
        isClickable: mdl.is_clickable,
      },
    };
  });

  // 如果整商品只有一个价没分款式
  if (!variants.length) {
    variants.push({
      variant: '(单一款式)',
      price: RM(item.price),
      promo_price: RM(item.price_before_discount),
      current: RM(item.price),
      stock: item.stock ?? item.normal_stock,
      sold_out: item.has_stock === false || item.stock === 0,
      available: true,
    });
  }

  return {
    title,
    sellerName: String(sellerName || ''),
    variants,
    // ── trace 用：listing 级原始信息（Phase 1，不参与写库/同步）──
    _trace: {
      apiItemId: item.itemid ?? item.item_id ?? '',
      apiShopId: item.shopid ?? item.shop_id ?? '',
      modelCount: models.length,
      tierVariations: tiers.map((t) => ({
        name: t?.name || '',
        optionCount: Array.isArray(t?.options) ? t.options.length : 0,
        options: Array.isArray(t?.options) ? t.options : [],
      })),
    },
  };
}

// 从 PDP 接口读「店铺 voucher」(比抠页面文字可靠)。
// 固定额(voucher_discount_type=1):微元 ÷ 100000 = RM。
// 其它类型(如百分比 type=2):先原样带出、不换算(待真实样本校准),voucherAmount=0。
export function extractShopVoucher(pdpJson) {
  const pp = pdpJson?.data?.product_price || pdpJson?.payload?.data?.product_price;
  const sv = pp?.final_price_info?.final_price_vouchers?.shop_voucher;
  if (!sv) return null;
  const type = Number(sv.voucher_discount_type);
  const raw = Number(sv.voucher_discount) || 0;
  const code = sv.voucher_code || '';
  if (type === 1) return { voucherAmount: raw / 100000, voucherType: 'fixed', voucherRaw: raw, code };
  return { voucherAmount: 0, voucherType: `type${type}`, voucherRaw: raw, code };
}

export async function scrapeProduct(url, { headless = true } = {}) {
  const ids = parseShopeeUrl(url);
  if (!ids) throw new Error('解析不出 shopId/itemId，链接格式不对：' + url);

  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    locale: 'en-MY',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined,
  });
  const page = await ctx.newPage();

  let pdpJson = null;
  let voucherInfo = { vouchers: [], fixed: 0, percent: 0 };
  const seenApi = []; // 调试：记下看到的所有 api/v4 请求
  // 拦截页面自己发的商品详情接口
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/api/v4/')) seenApi.push(u.split('?')[0]);
    if (/\/api\/v4\/(?:pdp\/get_pc|pdp\/get|item\/get)/.test(u)) {
      try {
        const txt = await res.text();
        try { fs.writeFileSync('out/pdp-raw.json', txt); } catch {}
        const j = JSON.parse(txt);
        if (j?.data?.item || j?.item || j?.data) pdpJson = j;
      } catch {}
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dismissLanguageGate(page, url);
    // 给接口一点时间回来
    for (let i = 0; i < 30 && !pdpJson; i++) await page.waitForTimeout(500);
    if (!pdpJson) {
      pdpJson = await page.evaluate(async ({ itemId, shopId }) => {
        try {
          const res = await fetch(`/api/v4/pdp/get_pc?item_id=${itemId}&shop_id=${shopId}`, {
            credentials: 'include',
            headers: {
              'x-api-source': 'pc',
              'x-shopee-language': 'en',
            },
          });
          return await res.json();
        } catch {
          return null;
        }
      }, { itemId: ids.itemId, shopId: ids.shopId });
      try {
        if (pdpJson) fs.writeFileSync('out/pdp-raw.json', JSON.stringify(pdpJson, null, 2));
      } catch {}
    }
    try { await ctx.storageState({ path: STATE_FILE }); } catch {}
    voucherInfo = await extractVoucherInfoFromPage(page);
    // 合并接口无门槛固定额券；百分比/满减以 DOM 文字为准。
    const _sv = extractShopVoucher(pdpJson);
    voucherInfo = { ...voucherInfo, vouchers: mergeApiFixedVoucher(voucherInfo.vouchers, _sv) };
  } finally {
    // 截图留证（看是不是被验证码挡了）
    try { await page.screenshot({ path: 'out/last-page.png', fullPage: false }); } catch {}
    await browser.close();
  }

  if (!pdpJson) {
    const apis = [...new Set(seenApi)].join('\n  ') || '(一个 api/v4 都没看到)';
    throw new Error('没拦到商品接口数据。看到的接口有：\n  ' + apis + '\n看 out/last-page.png 确认页面状态。');
  }

  const result = extractFromPdp(pdpJson);
  if (!result?.variants) {
    throw new Error('Shopee 返回了非商品数据，可能已掉登录态或被软拦截。');
  }
  const vouchers = voucherInfo.vouchers;
  const voucherAmount = bestUnconditionalFixed(vouchers);
  return { url, shopId: ids.shopId, itemId: ids.itemId, ...result, voucherAmount, vouchers, scrapedAt: new Date().toISOString() };
}

export async function scrapeProductViaCDP(url, {
  endpoint = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222',
  requireExistingPage = process.env.HERMES_CDP_REQUIRE_OPEN_PAGE === '1',
  allowCreatePage = process.env.HERMES_CDP_ALLOW_CREATE_PAGE === '1',
  allowNavigate = process.env.HERMES_CDP_ALLOW_NAVIGATE !== '0',
  reloadOnIssue = process.env.HERMES_CDP_RELOAD_ON_ISSUE === '1',
  preFetchDelayMs = Number(process.env.HERMES_CDP_PREFETCH_DELAY_MS || 2500),
} = {}) {
  const ids = parseShopeeUrl(url);
  if (!ids) throw new Error('解析不出 shopId/itemId，链接格式不对：' + url);
  const { host, port, secure } = parseCdpEndpoint(endpoint);
  let client = null;
  let browserClient = null;
  let target = null;
  let createdTarget = false;
  // 复用模式(默认开):专用 CDP Chrome 上只保留一个 tab 反复导航、只关多余的。
  // 跑完不关「在用的那个」,下次还能复用 → tab 收敛到 1 个。设 HERMES_CDP_REUSE_TAB=0 退回旧行为。
  const reuseTab = process.env.HERMES_CDP_REUSE_TAB !== '0';

  try {
    browserClient = await CDP({ host, port, secure, target: false });
    const { Target } = browserClient;
    await Target.setDiscoverTargets({ discover: true }).catch(() => {});

    const targets = await CDP.List({ host, port, secure });
    target = pickShopeeTarget(targets, ids, url);

    // 复用 + 清理:专用 CDP Chrome(C:\chrome-cdp-d3)上没必要每个商品开新 tab。
    // 没有精确匹配时,复用一个已存在的 Shopee 商品 tab(下面会导航过去),
    // 并关掉多余的商品 tab —— 把历史堆积的也一并清掉,避免越开越多。
    // 默认开;设 HERMES_CDP_REUSE_TAB=0 可退回「每个商品开新 tab」的旧行为。
    if (!target && reuseTab) {
      const productTabs = (targets || []).filter((t) => t.type === 'page' && isShopeeProductUrl(t.url));
      if (productTabs.length) {
        target = productTabs[0]; // 复用第一个;不标记 createdTarget,跑完不关它
        for (const extra of productTabs.slice(1)) {
          try { await CDP.Close({ host, port, secure, id: extra.id }); } catch {}
        }
      }
    }

    if (!target && allowCreatePage) {
      const created = await createBackgroundTarget(browserClient, url, host, port, secure);
      createdTarget = true;
      const refreshed = await CDP.List({ host, port, secure });
      target = pickShopeeTarget(refreshed, ids, url) || created;
    }

    if (!target) {
      if (requireExistingPage) {
        throw new Error('没有找到已打开的匹配 Shopee 商品页。先在同一个 Chrome 里手动打开这个商品页，再重跑。');
      }
      throw new Error('CDP 没找到可用的 Shopee 页面，也无法创建目标页面。');
    }

    client = await CDP({ host, port, secure, target: target.id || target });
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();

    const currentUrl = String(target.url || '');
    if (!matchesShopeeItemUrl(currentUrl, ids)) {
      if (!allowNavigate) {
        throw new Error('当前 Chrome 里没有这个商品的已预热页面，且本轮禁止自动跳转到新商品页。');
      }
      await Page.navigate({ url });
      await waitForPageLoad(Page, Number(process.env.HERMES_PAGE_LOAD_TIMEOUT_MS || 20000));
    } else {
      await waitForPageLoad(Page, 5000).catch(() => {});
    }

    let health = await evaluateJson(Runtime, buildHealthCheckExpression());
    if (!health) throw new Error('CDP 无法读取页面状态。');

    if (health.isLoginPage) {
      throw new Error('CDP 页面当前是 Shopee 登录页，需先在真实 Chrome 登录。');
    }

    if (preFetchDelayMs > 0) {
      await sleep(preFetchDelayMs);
    }

    if (reloadOnIssue && (health.hasLoadingIssue || health.hasUnavailable)) {
      await Page.reload({ ignoreCache: true });
      await waitForPageLoad(Page, 15000).catch(() => {});
      health = await evaluateJson(Runtime, buildHealthCheckExpression());
    }

    if (health?.isLoginPage) {
      throw new Error('CDP 页面刷新后仍然落在登录页。');
    }
    if (health?.hasLoadingIssue) {
      throw new Error('CDP 页面当前为 Loading Issue。');
    }
    if (health?.hasUnavailable) {
      throw new Error('CDP 页面当前为 Page Unavailable。');
    }

    // 被反爬拦(如 90309999)时：重载页面、等反爬 JS 跑完，再读一次。只有被拦的链接才慢，正常的不受影响。
    const ANTIBOT_RETRY = Number(process.env.HERMES_CDP_ANTIBOT_RETRY || 2);
    let voucherInfo = { vouchers: [], fixed: 0, percent: 0 };
    let fetchResult = null;
    for (let attempt = 0; attempt <= ANTIBOT_RETRY; attempt += 1) {
      voucherInfo = await extractVoucherInfoFromRuntime(Runtime);
      fetchResult = await evaluateJson(Runtime, buildPdpFetchExpression(ids));
      const antiBotCode = fetchResult?.payload?.error;
      if (antiBotCode && antiBotCode !== 0 && attempt < ANTIBOT_RETRY) {
        console.error(`[scraper] 被反爬拦 (${antiBotCode})，重载等待后重试 ${attempt + 1}/${ANTIBOT_RETRY}: ${url}`);
        await Page.reload({ ignoreCache: true });
        await waitForPageLoad(Page, 15000).catch(() => {});
        await sleep(5000 + attempt * 4000);
        continue;
      }
      break;
    }
    try {
      if (fetchResult) fs.writeFileSync('out/pdp-raw.json', JSON.stringify(fetchResult, null, 2));
    } catch {}

    try {
      const shot = await Page.captureScreenshot({ format: 'png' });
      if (shot?.data) fs.writeFileSync('out/last-page.png', Buffer.from(shot.data, 'base64'));
    } catch {}

    if (!fetchResult) {
      throw new Error('CDP 抓取失败：页面没有返回任何商品数据。');
    }
    if (!fetchResult.ok) {
      throw new Error(`[${fetchResult.errorType || 'cdp_fetch'}] ${fetchResult.errorMessage || '页面内 fetch 失败'}`);
    }

    // 固定额：接口(type 1)无门槛券比 DOM 可靠，合并进券列表；百分比/满减以 DOM 文字为准。
    const _sv = extractShopVoucher(fetchResult?.payload);
    const vouchers = mergeApiFixedVoucher(voucherInfo.vouchers, _sv);
    const voucherAmount = bestUnconditionalFixed(vouchers); // 记录级展示用(无门槛固定额最大值)

    const result = extractFromPdp(fetchResult.payload);
    if (!result?.variants) {
      throw new Error('CDP 抓取到的不是商品价格数据，可能当前 Chrome 里的 Shopee 没登录或被软拦截。');
    }

    return { url, shopId: ids.shopId, itemId: ids.itemId, ...result, voucherAmount, vouchers, scrapedAt: new Date().toISOString() };
  } finally {
    try { if (client) await client.close(); } catch {}
    try {
      // 复用模式:保留在用的 tab(下次复用,tab 不增长);非复用模式才关掉本次新建的 tab。
      if (createdTarget && target?.id && !reuseTab) await CDP.Close({ host, port, secure, id: target.id });
    } catch {}
    try { if (browserClient) await browserClient.close(); } catch {}
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function isShopeeProductUrl(candidateUrl) {
  const value = String(candidateUrl || '');
  return /shopee\.com\.my/i.test(value) && (/-i\.\d+\.\d+/.test(value) || /product\/\d+\/\d+/.test(value));
}

function pickShopeeTarget(targets, ids, url) {
  const pages = (targets || []).filter((target) => target.type === 'page');
  const exact = pages.find((target) => matchesShopeeItemUrl(target.url, ids));
  if (exact) return exact;

  const byExactUrl = pages.find((target) => String(target.url || '') === String(url));
  if (byExactUrl) return byExactUrl;
  // 不再复用任意现有 Shopee 商品页，避免抢用户正在看的 tab。
  // 找不到当前商品的精确页面时，后面统一走 Target.createTarget 开新页。
  return null;
}

async function createBackgroundTarget(browserClient, url, host, port, secure) {
  const { Target } = browserClient;
  try {
    const created = await Target.createTarget({
      url,
      newWindow: false,
      background: true,
    });
    return { id: created.targetId, url };
  } catch {
    const created = await CDP.New({ host, port, secure, url });
    return created;
  }
}

function waitForPageLoad(Page, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`页面加载超时 ${timeoutMs}ms`)), timeoutMs);
    Page.loadEventFired(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function evaluateJson(Runtime, expression) {
  const response = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return response?.result?.value ?? null;
}

function normalizeVoucherAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function normalizeVoucherInfo(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const vouchers = [];
  for (const v of list) {
    const fixed = Number(v?.fixed);
    const percent = Number(v?.percent);
    const minSpend = Number(v?.minSpend);
    const f = Number.isFinite(fixed) && fixed > 0 ? fixed : 0;
    // 百分比上限设 90%，挡住明显误读（如把价格数字当成百分比）。
    const p = Number.isFinite(percent) && percent > 0 && percent <= 90 ? percent : 0;
    const m = Number.isFinite(minSpend) && minSpend > 0 ? minSpend : 0;
    if (f > 0 || p > 0) vouchers.push({ fixed: f, percent: p, minSpend: m });
  }
  // fixed/percent = 无门槛券里的最大值，仅供记录级展示/兜底（无法表达门槛）。
  const free = vouchers.filter((v) => v.minSpend === 0);
  return {
    vouchers,
    fixed: free.reduce((mx, v) => Math.max(mx, v.fixed), 0),
    percent: free.reduce((mx, v) => Math.max(mx, v.percent), 0),
  };
}

// 把接口读到的无门槛固定额店铺券(type 1)并入 DOM 券列表。
function mergeApiFixedVoucher(vouchers, sv) {
  const list = Array.isArray(vouchers) ? [...vouchers] : [];
  if (sv && sv.voucherType === 'fixed' && Number(sv.voucherAmount) > 0) {
    list.push({ fixed: Number(sv.voucherAmount), percent: 0, minSpend: 0 });
  }
  return list;
}

// 记录级展示用：无门槛固定额券的最大值。
function bestUnconditionalFixed(vouchers) {
  return (Array.isArray(vouchers) ? vouchers : [])
    .filter((v) => !v.minSpend)
    .reduce((mx, v) => Math.max(mx, Number(v.fixed) || 0), 0);
}

async function extractVoucherInfoFromPage(page) {
  try {
    return normalizeVoucherInfo(await page.evaluate(buildVoucherInfoExpression()));
  } catch {
    return { fixed: 0, percent: 0 };
  }
}

async function extractVoucherInfoFromRuntime(Runtime) {
  try {
    return normalizeVoucherInfo(await evaluateJson(Runtime, buildVoucherInfoExpression()));
  } catch {
    return { fixed: 0, percent: 0 };
  }
}

// 从 DOM 抠 voucher 文字：每张券带回 {fixed(RM), percent(%), minSpend(满额门槛RM)}。
// 满减券(如「RM10 off, Min. spend RM500」)的门槛留到 runOnce 按款式价格判定是否生效。
function buildVoucherInfoExpression() {
  return String.raw`
    (() => {
      const out = [];
      const allEls = [
        ...document.querySelectorAll('[class*="voucher"], [class*="Voucher"]'),
        ...Array.from(document.querySelectorAll('*')).filter((el) => {
          const text = String(el.textContent || '');
          return el.children.length === 0 &&
            /(RM\s*\d+(?:\.\d+)?\s*(?:off|OFF))|(\d+(?:\.\d+)?\s*%\s*(?:off|OFF))/i.test(text) &&
            text.length < 120;
        })
      ];
      allEls.forEach((el) => {
        const text = String(el.textContent || '');
        const f = text.match(/RM\s*(\d+(?:\.\d+)?)\s*(?:off|OFF)/i);
        const p = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:off|OFF)/i);
        if (!f && !p) return;
        const ms = text.match(/min(?:imum)?\.?\s*spend\s*RM\s*(\d+(?:\.\d+)?)/i);
        out.push({
          fixed: f ? parseFloat(f[1]) : 0,
          percent: p ? parseFloat(p[1]) : 0,
          minSpend: ms ? parseFloat(ms[1]) : 0,
        });
      });
      return out;
    })()
  `;
}

function buildHealthCheckExpression() {
  return `
    (() => {
      const href = location.href;
      const text = ((document.body && document.body.innerText) || '').slice(0, 4000);
      return {
        href,
        title: document.title || '',
        readyState: document.readyState || '',
        isLoginPage: /login/i.test(href) || /log\\s*in/i.test(text),
        hasLoadingIssue: /Loading Issue/i.test(text),
        hasUnavailable: /Page Unavailable/i.test(text)
      };
    })()
  `;
}

function buildPdpFetchExpression(ids) {
  const itemId = JSON.stringify(ids.itemId);
  const shopId = JSON.stringify(ids.shopId);
  return `
    (async () => {
      try {
        const res = await fetch('/api/v4/pdp/get_pc?item_id=' + ${itemId} + '&shop_id=' + ${shopId}, {
          credentials: 'include',
          headers: {
            'x-api-source': 'pc',
            'x-shopee-language': 'en'
          }
        });
        let payload = null;
        try {
          payload = await res.json();
        } catch (error) {
          return {
            ok: false,
            errorType: 'json_parse',
            errorMessage: error?.message || String(error),
            status: res.status
          };
        }
        return {
          ok: res.ok,
          status: res.status,
          payload
        };
      } catch (error) {
        return {
          ok: false,
          errorType: 'page_fetch',
          errorMessage: error?.message || String(error),
          status: 0
        };
      }
    })()
  `;
}

// 直接命令行跑：node src/scraper.mjs "<链接>"
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2];
  if (!url) {
    console.error('用法：node src/scraper.mjs "<虾皮商品链接>"');
    process.exit(1);
  }
  scrapeProduct(url, { headless: process.env.HEADLESS !== '0' })
    .then((r) => {
      console.log('\n商品：', r.title);
      console.log('链接：', r.url);
      console.log('款式价格：');
      for (const v of r.variants) {
        const tag = v.sold_out ? ' [缺货]' : '';
        const promo = v.promo_price != null && v.promo_price !== v.price ? `  (促销 RM${v.promo_price})` : '';
        console.log(`  - ${v.variant}: RM${v.current}${promo}${tag}`);
      }
      console.log('\n抓取时间：', r.scrapedAt);
    })
    .catch((e) => {
      console.error('\n抓取失败：', e.message);
      process.exit(1);
    });
}
