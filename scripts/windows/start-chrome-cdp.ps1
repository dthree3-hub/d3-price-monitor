$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Chrome not found at $chrome"
}

# Chrome profile 目录。默认沿用原来的；要「不登录」抓取就设环境变量
#   $env:CHROME_CDP_PROFILE = "C:\chrome-cdp-d3-nologin"
# 用一个全新、从不登录 Shopee 的 profile —— 没账号可封，最坏只是 IP 被临时限速。
$profileDir = if ($env:CHROME_CDP_PROFILE) { $env:CHROME_CDP_PROFILE } else { "C:\chrome-cdp-d3" }
$args = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "--new-window",
  "--window-size=1280,900",
  "https://shopee.com.my/"
)

Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Minimized

Write-Output "Started Chrome CDP profile: $profileDir"
