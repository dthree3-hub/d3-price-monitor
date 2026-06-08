# D3 — Shopee 竞争对手价格监控

## 目标

做一个页面，集中看竞争对手 Shopee 手机价格，并让 `Hermes` 每天汇报谁降价了。

## 真实可行架构

`Hermes` 不直接去 Shopee 抓。

正确流程是：

1. Sarah 用自己已登录的 Chrome 打开 Shopee 商品页
2. 点 `抓价` 书签
3. 书签导出该商品的 JSON
4. 把这些 JSON 导入 `data/records.json`
5. 网页读取 `data/records.json` 展示全部历史价格和降价报告
6. `Hermes` 每天跑日报脚本，输出“今天谁降价了”

这样就避开了 Shopee 的反爬死路，同时仍然实现集中展示和日报。

## 现在已有的东西

- [bookmarklet/grab-price.js](/home/sarah/projects/D3/bookmarklet/grab-price.js:1)
  Sarah 浏览器里点一下抓单个商品
- [dist/grab-price.bookmarklet.txt](/home/sarah/projects/D3/dist/grab-price.bookmarklet.txt:1)
  可直接放进 Chrome 收藏栏
- [data/records.json](/home/sarah/projects/D3/data/records.json:1)
  历史价格库，网页和日报都读这份
- [dashboard/index.html](/home/sarah/projects/D3/dashboard/index.html:1)
  单页面 dashboard
- [dashboard/app.js](/home/sarah/projects/D3/dashboard/app.js:1)
  页面逻辑，会自动读取 `/data/records.json`
- [src/import-records.mjs](/home/sarah/projects/D3/src/import-records.mjs:1)
  把书签导出的 JSON 合并进历史库
- [src/report-drops.mjs](/home/sarah/projects/D3/src/report-drops.mjs:1)
  生成降价日报
- [src/server.mjs](/home/sarah/projects/D3/src/server.mjs:1)
  本地静态站点，给 dashboard 用

## 日常操作

### 1. Sarah 抓价

在 Shopee 商品页点书签，下载一批 `d3-shopee-price-*.json`

### 2. 导入历史库

```bash
cd /home/sarah/projects/D3
npm run import:data -- /path/to/json-folder
```

也可以直接指定多个文件：

```bash
npm run import:data -- file1.json file2.json
```

### 3. 打开页面

```bash
cd /home/sarah/projects/D3
npm run serve
```

然后访问：

```text
http://127.0.0.1:3030/
```

页面会自动读取 `data/records.json`，显示：

- 全部历史商品/款式价格
- 最近一次相对上一次的降价项
- 最大降幅
- 搜索和 CSV/JSON 导出

### 4. Hermes 每天跑日报

```bash
cd /home/sarah/projects/D3
npm run report:drops
```

输出会同时：

- 打印到终端
- 写入 [out/daily-report.md](/home/sarah/projects/D3/out/daily-report.md:1)

如果要挂到 `Hermes` 的定时任务，最小可用例子是：

```cron
0 18 * * * cd /home/sarah/projects/D3 && /usr/bin/npm run report:drops >> /home/sarah/projects/D3/out/hermes.log 2>&1
```

## Hermes 该做什么

`Hermes` 负责：

- 读取 `data/records.json`
- 生成每日降价报告
- 后续可接 Telegram / email / 内部通知

`Hermes` 不负责：

- 直接访问 Shopee 抓价
- Playwright/VPS 自动爬 Shopee

## 已知限制

- 同一款式至少要抓到两次，页面和日报才知道它“降价了”
- 现在仍是半自动录入，抓取动作要靠 Sarah 点书签
- `report-drops` 目前按“同一款式最近两次抓取”比较，不是按自然日历聚合

## 立刻可做的下一步

1. 给 `report-drops` 接 Telegram 发送
2. 增加 `competitor / our_price / our_sku` 对照表
3. 把“下载 JSON”升级成直接 `POST` 到内部接口或 Google Apps Script

## 本地 Hermes 自动版

现在已经补了本地 Hermes 轮询脚本，可以在这台电脑上每小时自动抓一次商品清单，再在有变化时发 Telegram。

### Windows 主方案

如果你要避免 WSL、Docker、Playwright 新浏览器和 ScraperAPI，主方案就是：

- 在 Windows 本机打开一个真实 Chrome
- 用 `CDP` 连接这个 Chrome 的现有 Shopee 登录态
- Hermes 每小时跑一次
- 抓到变化后自动更新本地 dashboard HTML，并可发 Telegram

推荐优先用 Windows 版 PowerShell 脚本：

- [scripts/windows/start-chrome-cdp.ps1](/home/sarah/projects/D3/scripts/windows/start-chrome-cdp.ps1:1)
- [scripts/windows/run-hermes-once.ps1](/home/sarah/projects/D3/scripts/windows/run-hermes-once.ps1:1)
- [scripts/windows/start-hermes.ps1](/home/sarah/projects/D3/scripts/windows/start-hermes.ps1:1)
- [scripts/windows/install-hourly-task.ps1](/home/sarah/projects/D3/scripts/windows/install-hourly-task.ps1:1)
- [scripts/windows/start-telegram-bot.ps1](/home/sarah/projects/D3/scripts/windows/start-telegram-bot.ps1:1)

### 1. 准备商品清单

编辑 [config/products.csv](/home/sarah/projects/D3/config/products.csv:1)，一行一个商品。

最关键的列只有：

- `competitor`
- `product_url`
- `status`（写 `active`）

### 2. 准备 `.env`

复制 `.env.example` 到 `.env`，至少确认这些值：

- `SCRAPERAPI_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `HERMES_INTERVAL_MINUTES=60`
- `HERMES_SCRAPE_MODE=scraperapi`

如果暂时不想发 Telegram，可以设：

```bash
HERMES_NOTIFY=0
```

如果你想让 Hermes 借你这台电脑的 Shopee 登录态自动抓，先执行：

```bash
cd /home/sarah/projects/D3
npm run shopee:login
```

浏览器会打开 Shopee。你手动登录后，回终端按一次 Enter，它会把登录态保存到 `out/shopee-state.json`。

如果 `Playwright` 新开浏览器会被 Shopee 拦，优先改用 `CDP` 模式连接你已经打开的真实 Chrome。

Windows 里先手动启动一个带远程调试端口的 Chrome：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-chrome-cdp.ps1
```

然后在这个 Chrome 里手动登录 Shopee，再把 `.env` 设成：

```bash
HERMES_SCRAPE_MODE=cdp
CHROME_CDP_URL=http://127.0.0.1:9222
```

在 Windows 本机直接运行时，不需要改成 WSL 能访问的地址，保留 `127.0.0.1:9222` 即可。

为了更像真人、减少风控，当前 Windows Hermes 默认已经改成更保守的慢速自动模式：

- 默认每轮只抓 `5` 条
- Hermes 会自己打开商品页
- 每打开一页会先停留大约 `5-6` 秒，再尝试取价
- 每条之间也会额外等待几秒
- 不会激进地连续刷新页面

也就是说，你不需要手动先把当轮商品页全打开；只要先把那个带 `9222` 的 Chrome 开好并登录 Shopee，Hermes 就会自己一页一页走。

### 3. 先跑一轮

```bash
powershell -ExecutionPolicy Bypass -File .\scripts\windows\run-hermes-once.ps1
```

输出会：

- 抓 `config/products.csv` 里的商品
- 合并进 `data/records.json`
- 生成 [out/hermes-latest.md](/home/sarah/projects/D3/out/hermes-latest.md:1)
- 自动重建 dashboard HTML（默认在 Windows 桌面 `D3-dashboard.html`，也可用 `D3_DASHBOARD_HTML` 覆盖）
- 如有变化就发 Telegram

如果还是出现 `90309999`，那就说明即使放慢到“开页后停几秒再抓”，Shopee 还是把这条自动链路当成风控对象。

### 4. 常驻运行

```bash
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-hermes.ps1
```

它会一直留在这台 Windows 电脑上，每 `HERMES_INTERVAL_MINUTES` 分钟跑一轮。
当前默认值是 `3` 分钟一轮。

日志会写到 [out/hermes.log](/home/sarah/projects/D3/out/hermes.log:1)

如果你要完全交给 Windows 自动执行，再运行一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-hourly-task.ps1
```

这会创建每小时执行一次的计划任务 `D3 Hermes Hourly`。

### 4.5 Telegram 问答 bot

先在 `.env` 填好：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `HERMES_NOTIFY=1`

然后在 Windows 里启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-telegram-bot.ps1
```

现在支持这些问法：

- `/status`
- `/changes`
- `/watchlist`
- `/run`
- `/add 对手名字 商品链接`
- `/help`

普通文本也支持简单识别，例如：

- `状态`
- `最近变价`
- `监控名单`
- `现在检查`

如果你要它更像“人话问答”，可以在 `.env` 再填：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL=deepseek-v4-flash`

填好后，普通文本会先走 DeepSeek 做意图判断，再交给 Hermes 执行。根据 DeepSeek 官方文档，当前 OpenAI 兼容 Chat API 使用 `https://api.deepseek.com/chat/completions`，可用模型包括 `deepseek-v4-flash` 和 `deepseek-v4-pro`；`deepseek-chat` 将在 2026-07-24 弃用。来源：DeepSeek API Docs [Your First API Call](https://api-docs.deepseek.com/) 与 [Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion).

例如这些句子也可以：

- `帮我跑价格`
- `最近谁改价了`
- `现在监控什么`
- `status 是什么意思`

新增监控商品时，直接在 Telegram 发：

```text
/add Spray Gadget https://shopee.com.my/xxxx-i.12345678.987654321
```

它会自动把这个商品写进 `config/products.csv`，下次 Hermes 运行时就会开始监控。

### 5. 目前边界

- Windows 本机方案推荐直接走 `cdp`
- `browser` 模式依然可能被 Shopee 拦
- `ScraperAPI` 仍可保留成兜底，但不建议作为长期主路线
- 真正“实时”仍然不是秒级推送，而是“每一轮自动抓取后立即通知”

## 旧实验代码

`src/scraper.mjs`、`src/scraperapi.mjs`、`src/test-scraperapi.mjs` 只是保留踩坑记录，不是当前主方案。
