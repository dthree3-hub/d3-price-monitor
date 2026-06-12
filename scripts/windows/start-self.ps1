$ErrorActionPreference = "Stop"

# D3 only - scrape ONLY our own store (self), one sweep. Separate from the scheduled Hermes.
# Run:  powershell -ExecutionPolicy Bypass -File C:\D3\scripts\windows\start-self.ps1
# Or double-click C:\D3\D3 only.bat
# NOTE: you must be logged into the small Shopee account in the CDP Chrome, or it gets nothing.

# Go to repo root (C:\D3) so it uses the latest code
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $repoRoot

# --- same env as start-hermes ---
$env:HERMES_SCRAPE_MODE = "cdp"
if (-not $env:CHROME_CDP_URL)                  { $env:CHROME_CDP_URL = "http://127.0.0.1:9222" }
if (-not $env:HERMES_RECOVERY)                 { $env:HERMES_RECOVERY = "1" }
if (-not $env:HERMES_RECOVERY_MAX_WAIT_MIN)    { $env:HERMES_RECOVERY_MAX_WAIT_MIN = "3" }
if (-not $env:HERMES_CDP_REUSE_TAB)            { $env:HERMES_CDP_REUSE_TAB = "1" }
if (-not $env:HERMES_ITEM_DELAY_MIN_MS)        { $env:HERMES_ITEM_DELAY_MIN_MS = "10000" }
if (-not $env:HERMES_ITEM_DELAY_MAX_MS)        { $env:HERMES_ITEM_DELAY_MAX_MS = "20000" }
if (-not $env:HERMES_CDP_REQUIRE_OPEN_PAGE)    { $env:HERMES_CDP_REQUIRE_OPEN_PAGE = "0" }
if (-not $env:HERMES_CDP_ALLOW_CREATE_PAGE)    { $env:HERMES_CDP_ALLOW_CREATE_PAGE = "1" }
if (-not $env:HERMES_CDP_ALLOW_NAVIGATE)       { $env:HERMES_CDP_ALLOW_NAVIGATE = "1" }
if (-not $env:HERMES_CDP_RELOAD_ON_ISSUE)      { $env:HERMES_CDP_RELOAD_ON_ISSUE = "0" }
if (-not $env:HERMES_CDP_PREFETCH_DELAY_MS)    { $env:HERMES_CDP_PREFETCH_DELAY_MS = "6000" }
if (-not $env:HERMES_CDP_FETCH_RETRY_DELAY_MS) { $env:HERMES_CDP_FETCH_RETRY_DELAY_MS = "5000" }

# put node on PATH
$nodeDir = Join-Path $env:ProgramFiles "nodejs"
if (Test-Path (Join-Path $nodeDir "node.exe")) { $env:Path = "$nodeDir;$env:Path" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js not found. Install Node.js LTS or add node.exe to PATH." }

# --- make sure Chrome CDP is ready: start one if down, reuse if already up (never two) ---
function Test-Cdp {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2
    return ($resp.StatusCode -eq 200)
  } catch {
    return $false
  }
}

if (Test-Cdp) {
  Write-Host "Chrome CDP already up (reusing existing window)." -ForegroundColor Green
} else {
  Write-Host "Chrome CDP not running, starting it..." -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot "start-chrome-cdp.ps1")
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-Cdp) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($ready) {
    Write-Host "Chrome CDP up. Waiting 8s for shopee to load. Make sure you are logged in." -ForegroundColor Green
    Start-Sleep -Seconds 8
  } else {
    Write-Warning "Chrome CDP port 9222 not ready after 30s. Continuing (will get nothing if not logged in)."
  }
}

# --- run the self-only sweep ---
Write-Host "[D3 only] Scraping our own store (self) now..." -ForegroundColor Cyan
& $node.Source .\src\sweep-self.mjs
