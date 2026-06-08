$ErrorActionPreference = "Stop"
$runtimeRoot = (& (Join-Path $PSScriptRoot "sync-runtime.ps1") | Select-Object -Last 1).ToString().Trim()
Set-Location $runtimeRoot

node .\src\telegram-bot.mjs
