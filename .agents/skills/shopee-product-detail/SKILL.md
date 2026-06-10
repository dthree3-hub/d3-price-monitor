---
name: shopee-product-detail
description: "Extract complete Shopee MY product data including ALL variant tier prices (Basic/Promo/Set A/Set B/Set C), shop vouchers, and effective after-voucher prices. Specifically designed for Shopee Malaysia competitor price monitoring. Use when: check shopee price, scrape shopee product, get competitor price shopee, shopee variant price, shopee voucher, shopee tier price, Basic Promo Set A price, shopee malaysia price check."
---

# Shopee MY — Product Detail + Voucher Extractor

> Shopee product URL → all variant prices (Basic/Promo/Set A/B/C) + shop voucher amounts + effective prices

## Language
All output follows the user's language.

## Objective
Extract complete Shopee Malaysia product data from a product page:
- All variant/tier prices (Basic, Promo, Set A, Set B, Set C)
- Shop voucher amounts (RM off / % off)
- Effective price after best voucher
- Stock availability per variant

## Prerequisites
- Browser is open and on the Shopee MY product page
- Page must be fully loaded (wait for prices to appear)

## Execution

### Step 1 — Navigate to product URL
```
navigate {shopee_product_url}
wait stable
```

### Step 2 — Extract all product data
```bash
eval "$(python scripts/extract-shopee-product.py)"
```

### Step 3 — Interpret results

Output format:
```json
{
  "url": "https://shopee.com.my/...",
  "shopId": "116917349",
  "itemId": "12345678",
  "name": "Samsung Galaxy A07 5G 256GB",
  "variants": [
    { "name": "256GB Basic", "tier": "Basic", "price": 630, "effectivePrice": 625, "stock": 50 },
    { "name": "256GB Promo Set", "tier": "Promo", "price": 605, "effectivePrice": 600, "stock": 30 },
    { "name": "256GB Set A", "tier": "A", "price": 680, "effectivePrice": 675, "stock": 20 }
  ],
  "vouchers": [
    { "type": "fixed", "amount": 5, "raw": "RM5 Off" }
  ],
  "bestVoucherAmount": 5
}
```

### Tier interpretation
| Variant name contains | Tier |
|----------------------|------|
| Basic / basic | Basic |
| Promo / Offer | Promo |
| Set A / A | Set A |
| Set B / B | Set B |
| Set C / C | Set C |

### After extraction — update D3 records
If the user wants to update the D3 Price Monitor dashboard with this data, use the bookmarklet or call the Worker API directly:
```
POST https://d3-price-worker.dthree.workers.dev/api/sync
X-D3-Secret: {secret}
Body: { "records": [...] }
```

## Known Limitations
- React fiber traversal depth limited to 500 nodes; very complex pages may miss data → DOM fallback activates
- Voucher detection relies on visible text; hidden/collapsed voucher panels may not be captured → click the voucher section first to expand it
- Some Shopee listings show price range instead of per-variant price; individual variant prices only available after clicking each variant

## Experience Notes
Path: `{working-directory}/shopee-product-skill-memories.md`

Before execution: read if exists — records past issues (DOM structure changes, new anti-bot measures).
After execution: if unexpected situation encountered, append:
`{YYYY-MM-DD}: {what happened} → {conclusion}`
