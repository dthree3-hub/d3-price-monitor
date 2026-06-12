#!/usr/bin/env python3
"""Crawl4AI side-channel diagnostics for one Shopee product URL.

This does not touch Hermes records, D1, or the dedicated Chrome CDP profile.
It opens a separate Crawl4AI browser, performs a page-context PDP fetch, writes
diagnostic artifacts, and optionally sends a Telegram alert on failure.
"""

import argparse
import asyncio
import html
import json
import os
import re
import sys
import textwrap
import time
import urllib.parse
import urllib.request
from pathlib import Path


def parse_env_file(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return values


def parse_shopee_url(url):
    match = re.search(r"-i\.(\d+)\.(\d+)", url)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}
    match = re.search(r"product/(\d+)/(\d+)", url)
    if match:
        return {"shopId": match.group(1), "itemId": match.group(2)}
    return None


def build_js(item_id, shop_id):
    return f"""
    (async () => {{
      const diag = {{
        ok: false,
        at: new Date().toISOString(),
        locationHref: location.href,
        title: document.title || "",
        readyState: document.readyState || "",
        bodySample: ((document.body && document.body.innerText) || "").slice(0, 1200),
        cookieCount: document.cookie ? document.cookie.split(";").filter(Boolean).length : 0,
        flags: {{}},
        pdp: {{ ok: false, status: 0, error: null, hasItem: false, modelsCount: 0, variantsCount: 0 }},
      }};

      const text = diag.bodySample;
      diag.flags = {{
        isLoginPage: /login|log\\s*in|sign\\s*in/i.test(location.href + "\\n" + text),
        hasLoadingIssue: /Loading Issue/i.test(text),
        hasUnavailable: /Page Unavailable|not available|unavailable/i.test(text),
        hasCaptchaText: /captcha|verify|verification|unusual traffic|robot/i.test(text),
        hasLanguageGate: /select your language|english/i.test(text),
      }};

      try {{
        const response = await fetch('/api/v4/pdp/get_pc?item_id={item_id}&shop_id={shop_id}', {{
          credentials: 'include',
          headers: {{ 'x-api-source': 'pc', 'x-shopee-language': 'en' }}
        }});
        diag.pdp.status = response.status;
        let payload = null;
        try {{
          payload = await response.json();
        }} catch (error) {{
          diag.pdp.parseError = error && error.message ? error.message : String(error);
        }}
        diag.pdp.ok = response.ok;
        diag.pdp.error = payload && Object.prototype.hasOwnProperty.call(payload, 'error') ? payload.error : null;
        const item = payload && payload.data && payload.data.item ? payload.data.item : null;
        diag.pdp.hasItem = Boolean(item);
        diag.pdp.modelsCount = item && Array.isArray(item.models) ? item.models.length : 0;
        diag.pdp.variantsCount = diag.pdp.modelsCount || (item ? 1 : 0);
        diag.pdp.title = item ? (item.title || item.name || "") : "";
      }} catch (error) {{
        diag.pdp.fetchError = error && error.message ? error.message : String(error);
      }}

      diag.ok = Boolean(diag.pdp.ok && (diag.pdp.error === null || diag.pdp.error === 0) && diag.pdp.hasItem);

      let el = document.querySelector('#d3-crawl4ai-diagnosis');
      if (!el) {{
        el = document.createElement('pre');
        el.id = 'd3-crawl4ai-diagnosis';
        el.style.display = 'none';
        document.documentElement.appendChild(el);
      }}
      el.textContent = JSON.stringify(diag);
    }})()
    """


def extract_marker_text(result):
    sources = [
        getattr(result, "html", "") or "",
        getattr(result, "cleaned_html", "") or "",
    ]
    pattern = re.compile(
        r"<(?P<tag>pre|div|textarea|script)\b[^>]*\bid=[\"']d3-crawl4ai-diagnosis[\"'][^>]*>(?P<body>.*?)</(?P=tag)>",
        re.IGNORECASE | re.DOTALL,
    )
    for source in sources:
        match = pattern.search(source)
        if match:
            return html.unescape(match.group("body")).strip()
    return ""


def classify(diag):
    if diag.get("ok"):
        return "ok", "Crawl4AI page-context PDP fetch succeeded."
    flags = diag.get("flags") or {}
    pdp = diag.get("pdp") or {}
    if flags.get("isLoginPage"):
        return "login", "Crawl4AI landed on a login page."
    if flags.get("hasLoadingIssue") or flags.get("hasUnavailable"):
        return "page_block", "Crawl4AI page shows Loading Issue or unavailable content."
    if flags.get("hasCaptchaText"):
        return "verification", "Crawl4AI page text suggests verification or bot challenge."
    if pdp.get("error") not in (None, 0):
        return "pdp_error", f"Shopee PDP returned error code {pdp.get('error')}."
    if pdp.get("status") and pdp.get("status") != 200:
        return "http_error", f"Shopee PDP returned HTTP {pdp.get('status')}."
    if pdp.get("fetchError"):
        return "fetch_error", f"Browser fetch failed: {pdp.get('fetchError')}"
    if not pdp.get("hasItem"):
        return "no_item", "PDP response did not contain data.item."
    return "unknown", "Crawl4AI diagnosis failed for an unknown reason."


async def run_diagnosis(url, out_dir):
    ids = parse_shopee_url(url)
    if not ids:
        raise RuntimeError(f"Cannot parse shopId/itemId from URL: {url}")

    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    except ImportError as exc:
        raise RuntimeError("crawl4ai is not installed for this Python.") from exc

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
        js_code_before_wait=build_js(ids["itemId"], ids["shopId"]),
        wait_for="css:#d3-crawl4ai-diagnosis",
        delay_before_return_html=float(os.getenv("HERMES_CRAWL4AI_DIAG_DELAY_SEC", "1")),
        page_timeout=int(os.getenv("HERMES_CRAWL4AI_TIMEOUT_MS", "60000")),
    )

    started = time.time()
    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await crawler.arun(url=url, config=run_config)

    marker = extract_marker_text(result)
    diag = {
        "tool": "crawl4ai",
        "url": url,
        "shopId": ids["shopId"],
        "itemId": ids["itemId"],
        "crawlSuccess": bool(result.success),
        "crawlStatusCode": getattr(result, "status_code", None),
        "crawlError": getattr(result, "error_message", None),
        "elapsedSeconds": round(time.time() - started, 2),
    }

    if marker:
        diag.update(json.loads(marker))
    else:
        diag["ok"] = False
        diag["markerMissing"] = True
        diag["htmlSample"] = ((getattr(result, "cleaned_html", "") or getattr(result, "html", "") or "")[:1200])

    verdict, reason = classify(diag)
    diag["verdict"] = verdict
    diag["reason"] = reason

    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "crawl4ai-diagnosis.json"
    md_path = out_dir / "crawl4ai-diagnosis.md"
    json_path.write_text(json.dumps(diag, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(diag), encoding="utf-8")
    return diag, json_path, md_path


def render_markdown(diag):
    pdp = diag.get("pdp") or {}
    flags = diag.get("flags") or {}
    lines = [
        "# Crawl4AI Shopee Diagnosis",
        "",
        f"- Time: {diag.get('at') or ''}",
        f"- Verdict: {diag.get('verdict')}",
        f"- Reason: {diag.get('reason')}",
        f"- URL: {diag.get('url')}",
        f"- Final URL: {diag.get('locationHref') or ''}",
        f"- Title: {diag.get('title') or ''}",
        f"- Cookie count: {diag.get('cookieCount')}",
        f"- PDP HTTP: {pdp.get('status')}",
        f"- PDP error: {pdp.get('error')}",
        f"- PDP has item: {pdp.get('hasItem')}",
        f"- Models count: {pdp.get('modelsCount')}",
        "",
        "## Flags",
        "",
    ]
    for key, value in flags.items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## Body Sample", "", "```text", str(diag.get("bodySample") or diag.get("htmlSample") or "")[:1200], "```", ""])
    return "\n".join(lines)


def send_telegram_if_needed(diag, env_values):
    if diag.get("verdict") == "ok":
        return False
    token = env_values.get("TELEGRAM_BOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = env_values.get("TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return False

    text = textwrap.dedent(f"""\
    Hermes Crawl4AI 诊断异常
    verdict: {diag.get('verdict')}
    reason: {diag.get('reason')}
    title: {diag.get('title') or '-'}
    url: {diag.get('url')}
    """).strip()
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": "true",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=data,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        response.read()
    return True


async def async_main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--out-dir", default="out")
    parser.add_argument("--env", default=".env")
    parser.add_argument("--notify", action="store_true")
    args = parser.parse_args()

    env_values = parse_env_file(Path(args.env))
    for key, value in env_values.items():
        os.environ.setdefault(key, value)

    diag, json_path, md_path = await run_diagnosis(args.url, Path(args.out_dir))
    notified = False
    if args.notify:
        try:
            notified = send_telegram_if_needed(diag, env_values)
        except Exception as exc:
            diag["telegramError"] = str(exc)
            json_path.write_text(json.dumps(diag, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({
        "verdict": diag.get("verdict"),
        "reason": diag.get("reason"),
        "json": str(json_path),
        "markdown": str(md_path),
        "telegramNotified": notified,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except Exception as exc:
        print(json.dumps({"verdict": "tool_error", "reason": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
