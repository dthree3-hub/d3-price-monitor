import sys

def main():
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')

    js = r"""
(function() {
  try {
    const result = { url: window.location.href, _platform: 'shopee_my', variants: [], vouchers: [] };

    // ── Shop ID + Item ID from URL ──────────────────────────────────────────
    const urlMatch = window.location.href.match(/i\.(\d+)\.(\d+)/);
    if (urlMatch) { result.shopId = urlMatch[1]; result.itemId = urlMatch[2]; }

    // ── Layer 1: Shopee React fiber → product models ────────────────────────
    function getFiberData() {
      const root = document.querySelector('#main, #app, body > div');
      if (!root) return null;
      const fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!fiberKey) return null;
      let fiber = root[fiberKey];
      let depth = 0;
      while (fiber && depth < 500) {
        depth++;
        const state = fiber.memoizedState;
        if (state && state.memoizedState) {
          const s = state.memoizedState;
          if (s && s.itemData && s.itemData.models) return s.itemData;
          if (s && s.models && Array.isArray(s.models)) return s;
        }
        if (fiber.memoizedProps) {
          const p = fiber.memoizedProps;
          if (p.itemData && p.itemData.models) return p.itemData;
        }
        fiber = fiber.child || fiber.sibling || (fiber.return && fiber.return.sibling);
      }
      return null;
    }

    const itemData = getFiberData();
    if (itemData && itemData.models) {
      result.name = itemData.name || null;
      result.shopId = result.shopId || String(itemData.shopid || '');
      result.itemId = result.itemId || String(itemData.itemid || '');
      for (const m of itemData.models) {
        const price = m.price != null ? m.price / 100000 : null;
        const originalPrice = m.price_before_discount != null ? m.price_before_discount / 100000 : null;
        result.variants.push({
          name: m.name || '',
          model: '',
          tier: '',
          price,
          originalPrice,
          stock: m.stock || 0,
          modelId: m.modelid,
        });
      }
      result._source = 'react_fiber';
    }

    // ── Layer 2: DOM fallback for price + title ─────────────────────────────
    if (!result.name) {
      result.name = document.querySelector('h1, [class*="productName"], [class*="product-name"], [class*="pdp-product-title"]')?.textContent?.trim() || null;
    }
    if (!result.variants.length) {
      const priceEls = document.querySelectorAll('[class*="priceSale"], [class*="price--current"], [class*="pdp-price"]');
      priceEls.forEach(el => {
        const txt = el.textContent.replace(/[^0-9.]/g, '');
        const p = parseFloat(txt);
        if (p > 0) result.variants.push({ name: 'Default', price: p });
      });
      if (result.variants.length) result._source = 'dom_price';
    }

    // ── Layer 3: Voucher extraction ─────────────────────────────────────────
    function extractVouchers() {
      const vouchers = [];
      // Find voucher section: look for elements containing "Voucher" text
      const allEls = Array.from(document.querySelectorAll('[class*="voucher"], [class*="Voucher"]'));
      // Also search by text content
      const byText = Array.from(document.querySelectorAll('*')).filter(el =>
        el.children.length === 0 &&
        /RM\s*\d+\s*(off|OFF)|(\d+)%\s*(off|OFF)|voucher/i.test(el.textContent) &&
        el.textContent.length < 80
      );
      [...allEls, ...byText].forEach(el => {
        const txt = el.textContent.trim();
        // Min. spend threshold (conditional voucher): "Min. spend RM500"
        const msMatch = txt.match(/min(?:imum)?\.?\s*spend\s*RM\s*(\d+(?:\.\d+)?)/i);
        const minSpend = msMatch ? parseFloat(msMatch[1]) : 0;
        // Fixed amount: RM5 off, RM 10 Off
        const rmMatch = txt.match(/RM\s*(\d+(?:\.\d+)?)\s*(?:off|OFF)/i);
        if (rmMatch) {
          vouchers.push({ type: 'fixed', amount: parseFloat(rmMatch[1]), minSpend, raw: txt });
          return;
        }
        // Percentage: 5% off
        const pctMatch = txt.match(/(\d+(?:\.\d+)?)\s*%\s*(?:off|OFF)/i);
        if (pctMatch) {
          vouchers.push({ type: 'percent', amount: parseFloat(pctMatch[1]), minSpend, raw: txt });
        }
      });
      // Deduplicate
      const seen = new Set();
      return vouchers.filter(v => {
        const k = `${v.type}:${v.amount}:${v.minSpend}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    result.vouchers = extractVouchers();

    // Per-variant best voucher: fixed = flat RM off; percent = price * pct/100.
    // Percentage discounts depend on the variant's own price, so they must be
    // computed per variant (5% of RM527 != 5% of RM999), not as one flat amount.
    function bestDiscountFor(price) {
      if (price == null) return 0;
      let best = 0;
      for (const v of result.vouchers) {
        // Conditional voucher: only applies when this variant's price meets the threshold.
        if (v.minSpend > 0 && price < v.minSpend) continue;
        const d = v.type === 'percent' ? price * (v.amount / 100) : v.amount;
        if (d > best) best = d;
      }
      return Math.round(best * 100) / 100;
    }

    // bestVoucherAmount kept for backward-compat: best fixed RM off (price-independent).
    const fixedVouchers = result.vouchers.filter(v => v.type === 'fixed');
    result.bestVoucherAmount = fixedVouchers.length
      ? Math.max(...fixedVouchers.map(v => v.amount))
      : 0;

    // Effective prices after the best voucher available for that variant's price.
    result.variants = result.variants.map(v => {
      const discount = bestDiscountFor(v.price);
      return {
        ...v,
        voucherAmount: discount,
        effectivePrice: v.price != null ? Math.max(0, Math.round((v.price - discount) * 100) / 100) : null,
      };
    });

    if (!result.name && !result.variants.length) {
      return JSON.stringify({ error: true, message: 'No Shopee product data found. Ensure page is fully loaded.' });
    }
    return JSON.stringify(result);
  } catch(e) {
    return JSON.stringify({ error: true, message: e.message });
  }
})()
"""
    print(js)

if __name__ == '__main__':
    main()
