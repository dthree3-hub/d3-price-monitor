$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Chrome not found at $chrome"
}

# Chrome profile 目录。默认用登录用的 profile（C:\chrome-cdp-d3）。
# 注意(2026-06-11 实测)：「不登录」自动化抓 Shopee 会被挡(Page Unavailable / 要登录)——
# 登出+自动化=不被信任。要抓数据必须登录(建议用不在乎的小号)。所以不登录这条死路，别用 nologin profile。
# 防封靠「温柔调度」(慢/不突发/碰验证停)，不是靠不登录。
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
