$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $sourceRoot

$envPath = Join-Path $sourceRoot ".env"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $idx = $line.IndexOf("=")
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    if ($key -and -not [Environment]::GetEnvironmentVariable($key, "Process")) {
      [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
  }
}

$python = $env:HERMES_CRAWL4AI_PYTHON
if (-not $python) {
  $defaultPython = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
  if (Test-Path $defaultPython) {
    $python = $defaultPython
  } else {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source }
  }
}
if (-not $python -or -not (Test-Path $python)) {
  throw "Python 3.12 not found. Set HERMES_CRAWL4AI_PYTHON in C:\D3\.env."
}

$url = Read-Host "Paste one Shopee product URL for Crawl4AI diagnosis"
if (-not $url) {
  throw "No URL provided."
}

Write-Host "Running Crawl4AI diagnosis. This does not touch Hermes CDP Chrome or D1..." -ForegroundColor Cyan
& $python ".\scripts\crawl4ai-diagnose-shopee.py" $url --out-dir ".\out" --env ".\.env" --notify

Write-Host ""
Write-Host "Diagnosis written to:" -ForegroundColor Green
Write-Host "  C:\D3\out\crawl4ai-diagnosis.json"
Write-Host "  C:\D3\out\crawl4ai-diagnosis.md"
Write-Host ""
Write-Host "Press Enter to close."
[void][System.Console]::ReadLine()
