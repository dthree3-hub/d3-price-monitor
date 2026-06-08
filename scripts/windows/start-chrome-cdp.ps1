$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Chrome not found at $chrome"
}

$profileDir = "C:\chrome-cdp-d3"
$args = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "--new-window",
  "--window-size=1280,900",
  "https://shopee.com.my/"
)

Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Minimized

Write-Output "Started Chrome CDP profile: $profileDir"
