// trace.mjs — Phase 1：为每条 listing 产出可审计的「价格来源 / SKU 解析」证据链，dump 到 out/traces/。
// 只读不写：不改写库逻辑、不覆盖价格、不碰同步/Worker。目的=先证明 trace 算得对。
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './lib-records.mjs';

const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);

// 需要网络版本区分的型号：平板(WiFi/LTE/5G)、以及有 4G+5G 两版的 A06/A07/A16/A17。
// 其余(A26/A36/A56 只 5G、S 手机、Z/Buds/Watch/Fit)单一网络，不缺网络也不扣分。
function needsNetwork(model) {
  const m = String(model || '');
  if (/^Tab\b/i.test(m)) return true;
  if (/^A(?:06|07|16|17)\b/i.test(m)) return true;
  return false;
}

// 取型号核心 token（去掉 Tab 前缀 / 网络 / 容量），用于「这个型号在 listing 预期范围内吗」校验。
function coreToken(model) {
  return String(model || '')
    .replace(/^Tab\s*/i, '')
    .replace(/\b(?:4G|5G|LTE|WiFi)\b/gi, '')
    .replace(/\b\d+\s*(?:GB|TB)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeText(s) {
  return String(s || '').replace(/\btab\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// 逐 SKU 解析置信度评分（100 分制）。返回 {total, breakdown, notes}。
export function scoreSku(parsed, raw, expectedText) {
  const notes = [];
  const model = parsed.model || '';

  // ① 型号识别 40：按 confidence 给分
  let modelScore = 0;
  if (!model) { modelScore = 0; notes.push('型号为空'); }
  else if (parsed.confidence === 'confirmed') modelScore = 40;
  else if (parsed.confidence === 'parsed') { modelScore = 30; notes.push('型号靠标题/itemModel推断'); }
  else if (parsed.confidence === 'fallback') { modelScore = 18; notes.push('型号回退(无容量)'); }
  else { modelScore = 8; notes.push('型号不确定'); }

  // ② 容量识别 20
  const capScore = parsed.capacity ? 20 : 0;
  if (!parsed.capacity) notes.push('缺容量');

  // ③ 网络版本识别 15
  let netScore;
  const hasNet = /\b(?:4G|5G|LTE|WiFi)\b/i.test(model);
  if (hasNet) netScore = 15;
  else if (needsNetwork(model)) { netScore = 0; notes.push('该型号需区分网络但缺网络'); }
  else netScore = 15;

  // ④ tier_index 重建完整度 15
  const tierCount = Number(raw?.tierCount) || 0;
  const dimsLen = Array.isArray(raw?.dims) ? raw.dims.length : 0;
  let tierScore;
  if (tierCount === 0) tierScore = 15; // 无变体维度，无需重建
  else if (dimsLen >= tierCount) tierScore = 15;
  else { tierScore = Math.round((15 * dimsLen) / tierCount); notes.push(`tier_index 不全(${dimsLen}/${tierCount})`); }

  // ⑤ 无冲突/无歧义 10：解析型号的核心 token 应出现在 listing 预期范围(标题+our_product)内
  let conflictScore = 0;
  const core = coreToken(model);
  const expNorm = normalizeText(expectedText);
  if (!model) conflictScore = 0;
  else if (core && expNorm.includes(core)) conflictScore = 10;
  else { conflictScore = 0; notes.push(`型号「${model}」不在 listing 预期范围内(可能串型号)`); }

  const total = modelScore + capScore + netScore + tierScore + conflictScore;
  return {
    total,
    breakdown: { model: modelScore, capacity: capScore, network: netScore, tierIndex: tierScore, noConflict: conflictScore },
    notes,
  };
}

// 完整性检测：接口模式下判断这条抓取可不可信。返回 {trusted, reasons}。
export function assessCompleteness(scraped) {
  const reasons = [];
  const variants = Array.isArray(scraped?.variants) ? scraped.variants : [];
  const t = scraped?._trace || {};
  if (variants.length === 0) reasons.push('models=0(无任何款式)');
  if (variants.length && variants.every((v) => v.current == null && v.price == null)) reasons.push('价格全为 null');
  if (!t.tierVariations || t.tierVariations.length === 0) reasons.push('tier_variations 缺失');
  // 接口返回的 item id 与 URL 的 id 不一致 → 抓错商品
  if (t.apiItemId && scraped.itemId && String(t.apiItemId) !== String(scraped.itemId)) {
    reasons.push(`itemId 不一致(接口${t.apiItemId} vs URL${scraped.itemId})`);
  }
  if (t.apiShopId && scraped.shopId && String(t.apiShopId) !== String(scraped.shopId)) {
    reasons.push(`shopId 不一致(接口${t.apiShopId} vs URL${scraped.shopId})`);
  }
  return { trusted: reasons.length === 0, reasons };
}

// 组装一条 listing 的完整 trace。
//  product: products.csv 行(含 our_product/keyword/product_url/competitor)
//  scraped: 抓取器返回(含 _trace / variants[]._raw)
//  parsedVariants: normalizeScrapedProduct 解析后的 variant 数组(含 model/capacity/tier/confidence/价格/voucher)
export function buildListingTrace(product, scraped, parsedVariants) {
  const expectedText = `${product?.our_product || ''} ${product?.keyword || ''} ${scraped?.title || ''}`;
  const completeness = assessCompleteness(scraped);

  const skus = parsedVariants.map((pv, i) => {
    const raw = scraped?.variants?.[i]?._raw || {};
    const score = scoreSku(pv, raw, expectedText);
    const current = round2(pv.currentPrice);
    const voucher = round2(pv.voucherAmount) || 0;
    const effective = current != null ? round2(current - voucher) : null;
    return {
      rawModelName: raw.modelName || '',
      dims: raw.dims || [],
      variantLabel: pv.name || '',
      parsed: {
        model: pv.model || '',
        capacity: pv.capacity || '',
        tier: pv.tier || '',
        color: pv.color || '',
        confidence: pv.confidence || '',
      },
      score: score.total,
      score_breakdown: score.breakdown,
      score_notes: score.notes,
      price: {
        raw_price: round2(pv.originalPrice),
        promotion_price: round2(pv.promoPrice),
        current_price: current,
        voucher_discount: voucher,
        effective_price: effective,
        final_price_type: pv.promoPrice != null ? 'promotion_price' : 'price',
      },
      stock: { hasStock: raw.hasStock, soldOut: pv.inStock === false },
    };
  });

  // 逐型号「最低 effective price 的款」——解释「这个型号的价是哪个 SKU 来的」(单 listing 内)
  const byModel = {};
  for (const s of skus) {
    const key = `${s.parsed.model}${s.parsed.capacity ? ' ' + s.parsed.capacity : ''}`;
    const eff = s.price.effective_price;
    if (eff == null) continue;
    if (!byModel[key] || eff < byModel[key].effective_price) {
      byModel[key] = { effective_price: eff, sku: s.variantLabel, tier: s.parsed.tier, score: s.score };
    }
  }

  return {
    scrapedAt: scraped?.scrapedAt || new Date().toISOString(),
    shopId: scraped?.shopId || '',
    itemId: scraped?.itemId || '',
    competitor: product?.competitor || '',
    url: product?.product_url || scraped?.url || '',
    title: scraped?.title || '',
    seller: scraped?.sellerName || '',
    targetHint: { our_product: product?.our_product || '', keyword: product?.keyword || '' },
    completeness,                         // {trusted, reasons}
    tierVariations: scraped?._trace?.tierVariations || [],
    skuCount: skus.length,
    lowConfidenceCount: skus.filter((s) => s.score < 85).length,
    skus,
    selectedLowestPerModel: byModel,      // 单 listing 内每型号最低 effective 价来自哪个 SKU
  };
}

// dump 到 out/traces/<日期>/<shop>_<item>.json（只写文件，不碰 D1/同步）。
export function dumpListingTrace(trace) {
  try {
    const day = (trace.scrapedAt || new Date().toISOString()).slice(0, 10);
    const dir = path.join(projectRoot, 'out', 'traces', day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${trace.shopId || 'x'}_${trace.itemId || 'x'}.json`);
    fs.writeFileSync(file, JSON.stringify(trace, null, 2));
    return file;
  } catch {
    return null;
  }
}
