# setup-env.ps1 — Safely scaffold the PRODUCTION .env in the D3-runtime root.
#
# What it does (safe to run repeatedly):
#   1. Detects the real D3-runtime path (same logic as sync-runtime.ps1).
#   2. Checks whether .env exists there.
#   3. If missing, creates it from .env.example with production values.
#   4. Ensures HERMES_RECOVERY=1 and HERMES_SCRAPE_MODE=cdp.
#   5. Adds EMPTY TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID placeholders only.
#   6. NEVER prints TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID values.
#   7. NEVER overwrites an existing .env's values (existing secrets preserved;
#      missing keys are appended, nothing existing is rewritten).
#
# Usage (on the Windows box):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-env.ps1
#   # add -DryRun to preview without writing.

[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = "Stop"

# --- 1) Detect runtime root (mirror of sync-runtime.ps1) ---
$runtimeRoot = if ($env:D3_RUNTIME_ROOT) { $env:D3_RUNTIME_ROOT } else { Join-Path $env:USERPROFILE "D3-runtime" }
$sourceRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root when run from a source checkout
$envPath     = Join-Path $runtimeRoot ".env"

Write-Host "D3-runtime : $runtimeRoot"
Write-Host ".env path  : $envPath"

# Prefer the example already mirrored into the runtime; fall back to the source checkout.
$examplePath = @(
  (Join-Path $runtimeRoot ".env.example"),
  (Join-Path $sourceRoot  ".env.example")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# --- helpers: write UTF-8 WITHOUT BOM (a BOM would corrupt the first key for Node's loader) ---
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}
function Append-Utf8NoBom([string]$Path, [string]$Text) {
  [System.IO.File]::AppendAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Non-secret production config. (Secrets are NOT in here — see $secretPlaceholders.)
$requiredConfig = [ordered]@{
  "HERMES_SCRAPE_MODE"            = "cdp"
  "HERMES_RECOVERY"               = "1"
  "HERMES_RECOVERY_MAX_WAIT_MIN"  = "20"
  "HERMES_RECOVERY_POLL_SEC"      = "8"
  "HERMES_RECOVERY_MAX_ROUNDS"    = "2"
  "HERMES_SESSION_COOKIE_DOMAINS" = "shopee"
  "CHROME_CDP_URL"                = "http://127.0.0.1:9222"
}
# Secret keys: ensure they EXIST as empty placeholders. Never set a value, never print one.
$secretPlaceholders = @("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")

if (-not (Test-Path $envPath)) {
  # --- 3) Create from template ---
  if (-not $examplePath) {
    throw "No .env and no .env.example found (looked in runtime root and source). Run sync-runtime.ps1 first."
  }
  Write-Host "No .env found. Creating from template: $examplePath"

  $out = New-Object System.Collections.Generic.List[string]
  $applied = @{}
  foreach ($line in (Get-Content -LiteralPath $examplePath -Encoding UTF8)) {
    $m = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=')
    if ($m.Success -and $requiredConfig.Contains($m.Groups[1].Value)) {
      # Template values are placeholders only, so setting them here is safe.
      $k = $m.Groups[1].Value
      $out.Add("$k=$($requiredConfig[$k])")
      $applied[$k] = $true
    } else {
      $out.Add($line)
    }
  }
  foreach ($k in $requiredConfig.Keys) { if (-not $applied.ContainsKey($k)) { $out.Add("$k=$($requiredConfig[$k])") } }
  foreach ($s in $secretPlaceholders) { if (-not ($out -match "^\s*$s\s*=")) { $out.Add("$s=") } }

  $text = ($out -join "`r`n") + "`r`n"
  if ($DryRun) {
    Write-Host "[DryRun] would create $envPath ($($out.Count) lines)"
  } else {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    Write-Utf8NoBom $envPath $text
    Write-Host "Created $envPath"
  }
} else {
  # --- existing .env: never rewrite values; only append what's missing ---
  Write-Host "Existing .env found — preserving all existing values (secrets untouched)."
  $existingKeys = @{}
  foreach ($line in (Get-Content -LiteralPath $envPath -Encoding UTF8)) {
    $m = [regex]::Match($line, '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')
    if ($m.Success) { $existingKeys[$m.Groups[1].Value] = $m.Groups[2].Value }
  }

  $toAppend = New-Object System.Collections.Generic.List[string]
  foreach ($k in $requiredConfig.Keys) {
    if (-not $existingKeys.ContainsKey($k)) {
      $toAppend.Add("$k=$($requiredConfig[$k])")
    } elseif ($existingKeys[$k].Trim() -ne $requiredConfig[$k]) {
      Write-Warning "$k is '$($existingKeys[$k].Trim())' but production expects '$($requiredConfig[$k])'. Leaving as-is — change by hand if intended."
    }
  }
  foreach ($s in $secretPlaceholders) {
    if (-not $existingKeys.ContainsKey($s)) { $toAppend.Add("$s=") }
  }

  if ($toAppend.Count -gt 0) {
    $block = "`r`n# --- added by setup-env.ps1 $(Get-Date -Format s) ---`r`n" + ($toAppend -join "`r`n") + "`r`n"
    if ($DryRun) { Write-Host "[DryRun] would append:`n$block" }
    else { Append-Utf8NoBom $envPath $block; Write-Host "Appended $($toAppend.Count) missing key(s)." }
  } else {
    Write-Host "All required keys already present. Nothing to add."
  }
}

# --- Report Telegram secret status WITHOUT revealing values ---
function Report-Secret([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { Write-Host "  $Key : (no .env)"; return }
  $line = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
  if (-not $line) { Write-Host "  $Key : MISSING"; return }
  $val = ($line -replace "^\s*$Key\s*=", "").Trim()
  if ([string]::IsNullOrWhiteSpace($val)) { Write-Host "  $Key : EMPTY  <-- paste your value here" }
  else { Write-Host "  $Key : set (hidden)" }
}

Write-Host ""
Write-Host "Telegram secret status (values are never displayed):"
Report-Secret $envPath "TELEGRAM_BOT_TOKEN"
Report-Secret $envPath "TELEGRAM_CHAT_ID"

Write-Host ""
Write-Host "Next steps — paste your two Telegram secrets by hand:"
Write-Host "  1. Open it:   notepad `"$envPath`""
Write-Host "  2. TELEGRAM_BOT_TOKEN=   <- paste the bot token from @BotFather"
Write-Host "  3. TELEGRAM_CHAT_ID=     <- paste your chat id (ask @userinfobot, or read getUpdates)"
Write-Host "  4. Save the file. Never commit it — .env is git-ignored."
Write-Host ""
Write-Host "Recovery is wired on: HERMES_RECOVERY=1, HERMES_SCRAPE_MODE=cdp."
Write-Host "Before running Hermes, start the CDP Chrome:  scripts\windows\start-chrome-cdp.ps1"
