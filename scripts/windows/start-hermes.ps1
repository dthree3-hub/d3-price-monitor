$ErrorActionPreference = "Stop"
$runtimeRoot = (& (Join-Path $PSScriptRoot "sync-runtime.ps1") | Select-Object -Last 1).ToString().Trim()
Set-Location $runtimeRoot

$env:HERMES_SCRAPE_MODE = "cdp"
if (-not $env:CHROME_CDP_URL) {
  $env:CHROME_CDP_URL = "http://127.0.0.1:9222"
}
if (-not $env:HERMES_INTERVAL_MINUTES) {
  $env:HERMES_INTERVAL_MINUTES = "3"
}
if (-not $env:HERMES_CYCLE_GAP_MINUTES) {
  $env:HERMES_CYCLE_GAP_MINUTES = "45"
}
# 碰验证页：暂停 + Telegram 通知你去手动解（不是破解）。开关 + 最长等待。
if (-not $env:HERMES_RECOVERY) {
  $env:HERMES_RECOVERY = "1"
}
# 最多等你过验证多久(分钟)。3 分钟内你没解 → 停止本轮(不继续抓)。
if (-not $env:HERMES_RECOVERY_MAX_WAIT_MIN) {
  $env:HERMES_RECOVERY_MAX_WAIT_MIN = "3"
}
# 复用同一个 tab 抓(导航而不是每次开新 tab)，更像真人、少触发验证
if (-not $env:HERMES_CDP_REUSE_TAB) {
  $env:HERMES_CDP_REUSE_TAB = "1"
}
# 定时模式：每天几点各跑一整圈（首个时段含自家店，其余只抓对手）
if (-not $env:HERMES_RUN_TIMES) {
  $env:HERMES_RUN_TIMES = "09:30,13:00,16:30"
}
# 每条之间随机间隔(毫秒)：防封关键——节奏不规律 + 慢
if (-not $env:HERMES_ITEM_DELAY_MIN_MS) {
  $env:HERMES_ITEM_DELAY_MIN_MS = "10000"
}
if (-not $env:HERMES_ITEM_DELAY_MAX_MS) {
  $env:HERMES_ITEM_DELAY_MAX_MS = "20000"
}
if (-not $env:HERMES_BATCH_SIZE) {
  $env:HERMES_BATCH_SIZE = "5"
}
if (-not $env:HERMES_ITEM_DELAY_MS) {
  $env:HERMES_ITEM_DELAY_MS = "12000"
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

& $node.Source .\src\hermes.mjs
