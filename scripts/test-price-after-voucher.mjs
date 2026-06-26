// 验证 RM546.30 这种 Shopee 页面红价(After Voucher)一路从 extractFromPdp → displayPrice → dashboard priceOf。
import assert from 'node:assert';
import { extractFromPdp } from '../src/scraper.mjs';

// dashboard 的 priceOf(d3-price/index.html:1567)：返回 displayPrice 否则 currentPrice。复制以验证链路尾端。
function priceOf(row) {
  const d = Number(row.displayPrice);
  if (Number.isFinite(d) && d > 0) return d;
  const p = Number(row.currentPrice);
  return Number.isFinite(p) ? p : null;
}

// mock get_pc：显示模型(id 111)挂牌 RM607，shop voucher 固定额 RM60.70 → 页面红价 RM546.30。
const payload = {
  data: {
    item: {
      title: 'Samsung Galaxy A06 5G',
      shop_name: 'Test Seller',
      tier_variations: [{ name: 'Color', options: ['Black', 'Blue'] }],
      models: [
        { model_id: 111, name: 'Black', price: 60700000, extinfo: { tier_index: [0] }, has_stock: true, is_clickable: true, is_grayout: false },
        { model_id: 222, name: 'Blue', price: 49300000, extinfo: { tier_index: [1] }, has_stock: true, is_clickable: true, is_grayout: false },
      ],
    },
    product_price: {
      has_final_price: true,
      price: { single_value: 54630000 },              // RM546.30 = 页面红价
      price_before_discount: { single_value: 60700000 },
      final_price_info: {
        model_id: 111,
        hint_text: 'After Voucher',
        final_price_vouchers: { shop_voucher: { voucher_discount_type: 1, voucher_discount: 6070000 } }, // 固定额 60.70
      },
    },
  },
};

const r = extractFromPdp(payload);
const black = r.variants.find((v) => v.variant === 'Black');
const blue = r.variants.find((v) => v.variant === 'Blue');

// 1) 显示模型(Black,id111)= 页面精确红价 546.30
assert.strictEqual(black.displayPrice, 546.30, `显示模型 displayPrice 应=546.30，实际 ${black.displayPrice}`);
assert.strictEqual(black.voucherSource, 'final_price_info(exact)', `应=exact，实际 ${black.voucherSource}`);
assert.strictEqual(black.displayedExact, true);
assert.strictEqual(black.rawSkuPrice, 607);
assert.strictEqual(black.voucherAmount, 60.7);

// 2) 其余变体(Blue)套 Shopee 实际固定额券 60.70：493 − 60.70 = 432.30
assert.strictEqual(blue.displayPrice, 432.30, `Blue displayPrice 应=432.30，实际 ${blue.displayPrice}`);
assert.strictEqual(blue.voucherSource, 'applied_voucher(fixed)');
assert.strictEqual(blue.displayedExact, false);

// 3) 链路尾端：dashboard priceOf 直接显示 displayPrice(after voucher)，不二次扣券
assert.strictEqual(priceOf({ displayPrice: black.displayPrice, currentPrice: black.rawSkuPrice }), 546.30,
  'dashboard 应显示 546.30(after voucher)');

console.log('✅ PASS: RM546.30 页面红价 → displayPrice → dashboard priceOf 全链路正确');
console.log(`   显示模型 Black: raw=${black.rawSkuPrice} → display=${black.displayPrice} (券${black.voucherAmount}, ${black.voucherSource})`);
console.log(`   其余 Blue:      raw=${blue.rawSkuPrice} → display=${blue.displayPrice} (券${blue.voucherAmount}, ${blue.voucherSource})`);
