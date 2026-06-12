#!/usr/bin/env python3
"""Crawl4AI-backed Shopee PDP extractor for Hermes.

Reads one Shopee product URL and prints normalized JSON to stdout. The Node
adapter owns retries, logging, and Hermes record normalization.
"""

import asyncio
import json
import os
import re
import sys


def parse_shopee_url(url):
    match = re.search(r"-i\.(\d+)\.(\d+)", url)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}
    match = re.search(r"product/(\d+)/(\d+)", url)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}
    return None


def rm(micros):
    if micros is None:
        return None
    try:
        value = float(micros)
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value / 100000


def extract_from_pdp(payload):
    if isinstance(payload, dict) and payload.get("error") not in (None, 0):
        raise RuntimeError(f"Shopee API error code {payload.get('error')}")

    item = None
    if isinstance(payload, dict):
        item = (
            payload.get("data", {}).get("item")
            if isinstance(payload.get("data"), dict)
            else None
        ) or payload.get("item") or payload.get("data")
    if not isinstance(item, dict):
        return None

    title = item.get("title") or item.get("name") or "(no title)"
    seller_name = item.get("shop_name") or item.get("shopid") or ""
    tiers = item.get("tier_variations") or []
    models = item.get("models") or []

    variants = []
    for model in models:
        if not isinstance(model, dict):
            continue
        label = model.get("name")
        tier_index = (model.get("extinfo") or {}).get("tier_index")
        if not label and tiers and isinstance(tier_index, list):
            parts = []
            for tier_idx, opt_idx in enumerate(tier_index):
                try:
                    option = tiers[tier_idx]["options"][opt_idx]
                except (IndexError, KeyError, TypeError):
                    option = None
                if option:
                    parts.append(str(option))
            label = " / ".join(parts)
        price = rm(model.get("price"))
        promo = rm(model.get("promotion_price"))
        variants.append(
            {
                "variant": label or "(default)",
                "price": price,
                "promo_price": promo,
                "current": promo if promo is not None else price,
                "stock": model.get("stock"),
                "sold_out": model.get("stock") == 0,
            }
        )

    if not variants:
        price = rm(item.get("price"))
        variants.append(
            {
                "variant": "(single)",
                "price": price,
                "promo_price": rm(item.get("price_before_discount")),
                "current": price,
                "stock": item.get("stock"),
                "sold_out": item.get("stock") == 0,
            }
        )

    return {"title": title, "sellerName": str(seller_name or ""), "variants": variants}


def extract_shop_voucher(payload):
    data = payload.get("data") if isinstance(payload, dict) else None
    product_price = data.get("product_price") if isinstance(data, dict) else None
    final_info = product_price.get("final_price_info") if isinstance(product_price, dict) else None
    shop_voucher = final_info.get("final_price_vouchers", {}).get("shop_voucher") if isinstance(final_info, dict) else None
    if not isinstance(shop_voucher, dict):
        return None

    voucher_type = int(shop_voucher.get("voucher_discount_type") or 0)
    raw = float(shop_voucher.get("voucher_discount") or 0)
    if voucher_type == 1 and raw > 0:
        return {"fixed": raw / 100000, "percent": 0, "minSpend": 0}
    return None


def normalize_vouchers(raw, api_voucher):
    vouchers = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            fixed = float(item.get("fixed") or 0)
            percent = float(item.get("percent") or 0)
            min_spend = float(item.get("minSpend") or 0)
            if percent > 90:
                percent = 0
            if fixed > 0 or percent > 0:
                vouchers.append({"fixed": max(0, fixed), "percent": max(0, percent), "minSpend": max(0, min_spend)})
    if api_voucher:
        vouchers.append(api_voucher)
    return vouchers


def build_js(item_id, shop_id):
    return f"""
    (async () => {{
      const out = {{ ok: false, status: 0, payload: null, vouchers: [], errorMessage: "" }};
      try {{
        const response = await fetch('/api/v4/pdp/get_pc?item_id={item_id}&shop_id={shop_id}', {{
          credentials: 'include',
          headers: {{ 'x-api-source': 'pc', 'x-shopee-language': 'en' }}
        }});
        out.status = response.status;
        out.payload = await response.json();
        out.ok = response.ok;
      }} catch (error) {{
        out.errorMessage = error && error.message ? error.message : String(error);
      }}

      try {{
        const vouchers = [];
        const allEls = [
          ...document.querySelectorAll('[class*="voucher"], [class*="Voucher"]'),
          ...Array.from(document.querySelectorAll('*')).filter((el) => {{
            const text = String(el.textContent || '');
            return el.children.length === 0 &&
              /(RM\\s*\\d+(?:\\.\\d+)?\\s*(?:off|OFF))|(\\d+(?:\\.\\d+)?\\s*%\\s*(?:off|OFF))/i.test(text) &&
              text.length < 120;
          }})
        ];
        allEls.forEach((el) => {{
          const text = String(el.textContent || '');
          const f = text.match(/RM\\s*(\\d+(?:\\.\\d+)?)\\s*(?:off|OFF)/i);
          const p = text.match(/(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:off|OFF)/i);
          if (!f && !p) return;
          const ms = text.match(/min(?:imum)?\\.?\\s*spend\\s*RM\\s*(\\d+(?:\\.\\d+)?)/i);
          vouchers.push({{
            fixed: f ? parseFloat(f[1]) : 0,
            percent: p ? parseFloat(p[1]) : 0,
            minSpend: ms ? parseFloat(ms[1]) : 0,
          }});
        }});
        out.vouchers = vouchers;
      }} catch {{}}

      let el = document.querySelector('#d3-pdp-json');
      if (!el) {{
        el = document.createElement('script');
        el.id = 'd3-pdp-json';
        el.type = 'application/json';
        document.documentElement.appendChild(el);
      }}
      el.textContent = JSON.stringify(out);
    }})()
    """


async def crawl(url):
    ids = parse_shopee_url(url)
    if not ids:
        raise RuntimeError(f"Cannot parse shopId/itemId from URL: {url}")

    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, JsonCssExtractionStrategy, CacheMode
    except ImportError as exc:
        raise RuntimeError("crawl4ai is not installed. Run: pip install -U crawl4ai && crawl4ai-setup") from exc

    schema = {
        "name": "Hermes Shopee PDP",
        "baseSelector": "#d3-pdp-json",
        "fields": [{"name": "json", "selector": "", "type": "text"}],
    }

    browser_config = BrowserConfig(
        headless=os.getenv("HEADLESS", "1") != "0",
        browser_type=os.getenv("HERMES_CRAWL4AI_BROWSER", "chromium"),
        verbose=os.getenv("HERMES_CRAWL4AI_VERBOSE", "0") == "1",
        user_agent_mode=os.getenv("HERMES_CRAWL4AI_USER_AGENT_MODE", ""),
        enable_stealth=os.getenv("HERMES_CRAWL4AI_STEALTH", "0") == "1",
    )
    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        wait_until=os.getenv("HERMES_CRAWL4AI_WAIT_UNTIL", "domcontentloaded"),
        wait_for="css:body",
        js_code=build_js(ids["itemId"], ids["shopId"]),
        page_timeout=int(os.getenv("HERMES_CRAWL4AI_TIMEOUT_MS", "60000")),
        extraction_strategy=JsonCssExtractionStrategy(schema),
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)

    if not result.success:
        raise RuntimeError(f"Crawl4AI failed: {result.status_code} {result.error_message}")

    extracted = json.loads(result.extracted_content or "[]")
    if not extracted:
        raise RuntimeError("Crawl4AI did not extract #d3-pdp-json")
    payload_text = extracted[0].get("json") if isinstance(extracted[0], dict) else None
    if not payload_text:
        raise RuntimeError("Crawl4AI extracted empty PDP payload")

    fetched = json.loads(payload_text)
    if not fetched.get("ok"):
        error = fetched.get("errorMessage") or f"HTTP {fetched.get('status')}"
        raise RuntimeError(f"Shopee PDP fetch failed via Crawl4AI: {error}")

    payload = fetched.get("payload")
    data = extract_from_pdp(payload)
    if not data or not data.get("variants"):
        raise RuntimeError("Crawl4AI fetched non-product PDP data")

    vouchers = normalize_vouchers(fetched.get("vouchers"), extract_shop_voucher(payload))
    voucher_amount = max((v.get("fixed", 0) for v in vouchers if not v.get("minSpend")), default=0)
    return {
        "url": url,
        "shopId": ids["shopId"],
        "itemId": ids["itemId"],
        **data,
        "voucherAmount": voucher_amount,
        "vouchers": vouchers,
    }


async def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: crawl4ai-shopee.py <shopee-product-url>")
    result = await crawl(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
