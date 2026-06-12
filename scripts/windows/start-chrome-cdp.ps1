$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  throw "Chrome not found at $chrome"
}

# Chrome profile 目录。默认用全新干净 profile（C:\chrome-cdp-d3-leon）：登小号用。
# 旧的 C:\chrome-cdp-d3 已被污染(sarahng903 被封)，C:\chrome-cdp-d3-nologin 是不登录方案(死路，别用)。
# 注意(2026-06-11 实测)：「不登录」自动化抓 Shopee 会被挡(Page Unavailable / 要登录)——
# 登出+自动化=不被信任。要抓数据必须登录(用不在乎的小号)。防封靠「温柔调度」(慢/不突发/碰验证停)，不是靠不登录。
# 要换 profile，设 $env:CHROME_CDP_PROFILE = "你的路径"。
$profileDir = if ($env:CHROME_CDP_PROFILE) { $env:CHROME_CDP_PROFILE } else { "C:\chrome-cdp-d3-leon" }
$args = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "--new-window",
  "--window-size=1280,900",
  "https://shopee.com.my/"
)

Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Minimized

Write-Output "Started Chrome CDP profile: $profileDir"
