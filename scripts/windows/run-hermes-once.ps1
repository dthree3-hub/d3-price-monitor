$ErrorActionPreference = "Stop"
$runtimeRoot = (& (Join-Path $PSScriptRoot "sync-runtime.ps1") | Select-Object -Last 1).ToString().Trim()
Set-Location $runtimeRoot

$env:HERMES_SCRAPE_MODE = "cdp"
if (-not $env:CHROME_CDP_URL) {
  $env:CHROME_CDP_URL = "http://127.0.0.1:9222"
}
if (-not $env:HERMES_BATCH_SIZE) {
  $env:HERMES_BATCH_SIZE = "5"
}
if (-not $env:HERMES_ITEM_DELAY_MS) {
  $env:HERMES_ITEM_DELAY_MS = "10000"
}
if (-not $env:HERMES_CDP_REQUIRE_OPEN_PAGE) {
  $env:HERMES_CDP_REQUIRE_OPEN_PAGE = "0"
}
if (-not $env:HERMES_CDP_ALLOW_CREATE_PAGE) {
  $env:HERMES_CDP_ALLOW_CREATE_PAGE = "1"
}
if (-not $env:HERMES_CDP_ALLOW_NAVIGATE) {
  $env:HERMES_CDP_ALLOW_NAVIGATE = "1"
}
if (-not $env:HERMES_CDP_RELOAD_ON_ISSUE) {
  $env:HERMES_CDP_RELOAD_ON_ISSUE = "0"
}
if (-not $env:HERMES_CDP_PREFETCH_DELAY_MS) {
  $env:HERMES_CDP_PREFETCH_DELAY_MS = "6000"
}
if (-not $env:HERMES_CDP_FETCH_RETRY_DELAY_MS) {
  $env:HERMES_CDP_FETCH_RETRY_DELAY_MS = "5000"
}

$nodeDir = Join-Path $env:ProgramFiles "nodejs"
if (Test-Path (Join-Path $nodeDir "node.exe")) {
  $env:Path = "$nodeDir;$env:Path"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js not found. Install Node.js LTS or add node.exe to PATH."
}

& $node.Source .\src\runOnce.mjs
