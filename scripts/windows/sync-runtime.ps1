$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtimeRoot = if ($env:D3_RUNTIME_ROOT) { $env:D3_RUNTIME_ROOT } else { Join-Path $env:USERPROFILE "D3-runtime" }

function Invoke-RobocopyMirror {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path $Source)) { return }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  & robocopy $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) {
    throw "robocopy failed: $Source -> $Destination (exit $LASTEXITCODE)"
  }
}

function Copy-FileIfNewer {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path $Source)) { return }
  $src = Get-Item $Source
  if (-not (Test-Path $Destination)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item $Source $Destination -Force
    return
  }

  $dst = Get-Item $Destination
  if ($src.LastWriteTimeUtc -gt $dst.LastWriteTimeUtc) {
    Copy-Item $Source $Destination -Force
  }
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

$mirrorDirs = @(
  "src",
  "dashboard",
  "d3-price",
  "scripts"
)

foreach ($dir in $mirrorDirs) {
  Invoke-RobocopyMirror -Source (Join-Path $sourceRoot $dir) -Destination (Join-Path $runtimeRoot $dir)
}

$copyFiles = @(
  "package.json",
  "package-lock.json",
  ".env",
  ".env.example",
  "README.md",
  "HANDOFF.md"
)

foreach ($file in $copyFiles) {
  Copy-FileIfNewer -Source (Join-Path $sourceRoot $file) -Destination (Join-Path $runtimeRoot $file)
}

Copy-FileIfNewer -Source (Join-Path $sourceRoot "config\products.csv") -Destination (Join-Path $runtimeRoot "config\products.csv")
Copy-FileIfNewer -Source (Join-Path $sourceRoot "config\products.example.csv") -Destination (Join-Path $runtimeRoot "config\products.example.csv")
Copy-FileIfNewer -Source (Join-Path $sourceRoot "data\records.json") -Destination (Join-Path $runtimeRoot "data\records.json")

$pkgSentinels = @(
  (Join-Path $runtimeRoot "node_modules\chrome-remote-interface\package.json"),
  (Join-Path $runtimeRoot "node_modules\playwright-extra\package.json")
)
if ($pkgSentinels | Where-Object { -not (Test-Path $_) }) {
  Push-Location $runtimeRoot
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

Write-Output $runtimeRoot
