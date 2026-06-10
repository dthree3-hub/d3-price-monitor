# Production `.env` setup (Windows / D3-runtime)

Hermes runs in production from the **D3-runtime** mirror, not from the source checkout.
Its `.env` lives at `…\D3-runtime\.env` and is **never touched by `sync-runtime.ps1`**
(sync only copies `.env` when a *source* `.env` exists — and it doesn't — so your
production secrets survive every sync).

## One command

```powershell
# 1) make sure the runtime exists / is up to date
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\sync-runtime.ps1

# 2) scaffold the .env safely (idempotent)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-env.ps1
```

Add `-DryRun` to `setup-env.ps1` to preview without writing.

## What `setup-env.ps1` guarantees

- Detects the real runtime path (`$env:D3_RUNTIME_ROOT`, else `%USERPROFILE%\D3-runtime`) —
  same logic as `sync-runtime.ps1`.
- If `.env` is **missing** → creates it from `.env.example` with production values.
- If `.env` **exists** → preserves every existing value; only **appends missing keys**.
  It never rewrites or deletes your secrets.
- Forces the two production toggles to be present:
  - `HERMES_SCRAPE_MODE=cdp`
  - `HERMES_RECOVERY=1`
  - (plus recovery tuning + `HERMES_SESSION_COOKIE_DOMAINS=shopee`, `CHROME_CDP_URL`)
- Adds **empty** `TELEGRAM_BOT_TOKEN=` / `TELEGRAM_CHAT_ID=` placeholders if absent.
- **Never prints** your token or chat id — it only reports `set (hidden)` / `EMPTY`.

## Then paste your two secrets by hand

```powershell
notepad "$env:USERPROFILE\D3-runtime\.env"   # or your $D3_RUNTIME_ROOT path
```

- `TELEGRAM_BOT_TOKEN=` → the token from **@BotFather**.
- `TELEGRAM_CHAT_ID=` → your chat id (ask **@userinfobot**, or read it from `getUpdates`).

Save. Do **not** commit `.env` (it is git-ignored).

## Before running Hermes

Recovery needs the live CDP Chrome up:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start-chrome-cdp.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\start-hermes.ps1
```

When a verification / login / Cloudflare / block / session-expired page appears, Hermes
pauses, alerts you on Telegram with a screenshot, waits while you clear it **manually in
that Chrome window**, saves the session, and resumes automatically.
