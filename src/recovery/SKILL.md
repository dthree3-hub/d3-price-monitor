---
name: hermes-verification-recovery
description: "Detect verification / login / Cloudflare / access-denied / session-expired pages during Hermes CDP scraping, pause the task, notify the operator on Telegram with a screenshot, wait for a human to clear the challenge in the real Chrome, persist the verified session, and resume the original task automatically. Detection + human-handoff only — no CAPTCHA solving, no challenge bypass, no third-party solver services."
---

# Hermes Verification Recovery

> When a site shows a verification / login / block page, **stop automating, hand off to a human**, then resume — reliably.

## Scope (and explicit non-scope)
This skill **does not** solve, bypass, or automate past any challenge. It only:
1. **Detects** that a human-gated page is showing.
2. **Pauses** the task and **saves** the current URL, task context, and a screenshot.
3. **Notifies** the operator on Telegram (title + URL + screenshot).
4. **Waits** while the operator clears the challenge **manually in the real Chrome**.
5. **Persists** the resulting session and **resumes** the original task.

No CAPTCHA solving. No challenge-solving systems. No third-party CAPTCHA services.

## How it plugs into Hermes
Targets the **CDP → real Chrome** path (`HERMES_SCRAPE_MODE=cdp`, `CHROME_CDP_URL`), because a
human can only intervene in a live, visible browser. The headless Playwright path can't host
manual intervention.

Enable with one env flag (default off, behavior unchanged when off):

```
HERMES_SCRAPE_MODE=cdp
HERMES_RECOVERY=1
```

`runOnce.mjs` then routes each CDP scrape through `guardCdpScrape()` instead of
`scrapeProductViaCDP()`. On a verification page it runs the recovery flow and retries.

## Modules
| Module | Responsibility |
|---|---|
| `VerificationDetector.mjs` | Classify the live page: `captcha / cloudflare / login_required / access_denied / session_expired / none`. Pure `detectFromSnapshot()` for tests; `detectViaCDP()` for the live tab; `classifyError()` maps existing scraper errors. |
| `SessionManager.mjs` | Capture/save/restore cookies + localStorage + sessionStorage. Writes Playwright `storageState` to `out/shopee-state.json` (reused by the scraper) + full session to `out/recovery/session.json`. |
| `BrowserStateManager.mjs` | Save URL, task context, screenshot, and a `pending.json` checkpoint so a restarted Hermes knows where it stalled. |
| `TelegramNotifier.mjs` | Send the verification alert (caption + screenshot via `sendPhoto`) and the resumed/aborted/timeout notices. Reuses existing `TELEGRAM_*` env. |
| `ResumeController.mjs` | Orchestrates detect → pause → notify → wait → restore → resume, emitting the five lifecycle log events. |

High-level entry: `guardCdpScrape(url, { taskContext })` in `index.mjs`.

## Completion detection
- **Primary:** poll `detect()` on the live tab. When the human clears the challenge, the page
  unblocks and the task resumes automatically.
- **Manual override:** a local signal file `out/recovery/signal` (`resume` / `abort`).
  We deliberately do **not** open a second Telegram `getUpdates` poller — `telegram-bot.mjs`
  already long-polls the bot, and two pollers would steal each other's updates.
  To support `/resume` and `/abort` from chat, add one line to `telegram-bot.mjs`:

  ```js
  import { writeManualSignal } from './recovery/TelegramNotifier.mjs';
  // in the command handler:
  if (text === '/resume') writeManualSignal('resume');
  if (text === '/abort')  writeManualSignal('abort');
  ```

## Lifecycle events (logged)
Written to `out/recovery/events.log` (structured JSON) and `out/hermes.log` (human-readable):
`verification_detected` → `waiting_for_user` → `verification_completed` → `session_restored` → `task_resumed`
(plus `aborted` / `timeout`).

## Security model
- **No credentials stored, ever.** Only session cookies/storage are persisted — never passwords.
- **Cookies are secrets.** Session files live under `out/` (git-ignored), written atomically with `chmod 600`,
  and cookies are filtered to `HERMES_SESSION_COOKIE_DOMAINS` (default `shopee`) to shrink the sensitive surface.
- **Never logged.** Logs and Telegram captions contain only counts and a query-stripped URL.
  `redact()` defensively masks any `cookie/token/password/session/value/...` key; `summarize()` emits counts only.
- **Screenshots** may contain on-page info; they go only to the operator's own Telegram chat and `out/recovery/` (git-ignored).

## Config (env)
| Var | Default | Meaning |
|---|---|---|
| `HERMES_RECOVERY` | `0` | Master switch (set `1` to enable). |
| `HERMES_RECOVERY_MAX_WAIT_MIN` | `20` | Max minutes to wait for the human. |
| `HERMES_RECOVERY_POLL_SEC` | `8` | Page re-check interval while waiting. |
| `HERMES_RECOVERY_MAX_ROUNDS` | `2` | Max recovery→retry rounds before giving up. |
| `HERMES_SESSION_COOKIE_DOMAINS` | `shopee` | Comma-list of cookie domains to persist. |

## Tested
Pure logic (detector classification, error mapping, redaction, session summarize) is covered by an
offline unit pass — no browser, no network. The CDP-bound paths require `chrome-remote-interface`
(already a Hermes dependency) and a running Chrome at `CHROME_CDP_URL`.
