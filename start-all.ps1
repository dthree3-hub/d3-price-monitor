$ErrorActionPreference = "Stop"

# D3 one-click launcher.
# Order: Chrome CDP -> wait for port 9222 -> Hermes + Telegram bot (each in its own window).
# Run:  powershell -ExecutionPolicy Bypass -File C:\D3\start-all.ps1
# Or just double-click start-all.bat in the same folder.

$scriptsDir = Join-Path $PSScriptRoot "scripts\windows"

# --- 1. Chrome CDP ---
Write-Host "[1/3] Starting Chrome CDP (port 9222)..." -ForegroundColor Cyan
& (Join-Path $scriptsDir "start-chrome-cdp.ps1")

# --- 2. Wait until CDP endpoint answers ---
Write-Host "[2/3] Waiting for Chrome CDP to be ready..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if ($ready) {
  Write-Host "      Chrome CDP is up. Waiting 8s for shopee.com.my to load..." -ForegroundColor Green
  Start-Sleep -Seconds 8
} else {
  Write-Warning "Chrome CDP port 9222 not ready after 30s. Continuing anyway (Hermes will retry)."
}

# --- 3. Hermes + Telegram bot, each in its own window ---
Write-Host "[3/3] Starting Hermes + Telegram bot..." -ForegroundColor Cyan

$hermesScript   = Join-Path $scriptsDir "start-hermes.ps1"
$telegramScript = Join-Path $scriptsDir "start-telegram-bot.ps1"

Start-Process powershell -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$hermesScript`""
)
Start-Process powershell -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$telegramScript`""
)

Write-Host ""
Write-Host "All started. Hermes and Telegram bot are running in their own windows." -ForegroundColor Green
Write-Host "Close those windows (or Ctrl+C inside them) to stop." -ForegroundColor Green
