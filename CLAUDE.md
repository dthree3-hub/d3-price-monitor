# D3 Price Monitor — Claude 工作说明

Shopee MY 价格监控。Hermes 抓取跑在 **Windows**（`C:\Users\Asus\D3-runtime`，由 `C:\D3` 镜像而来），Worker/前端从这份 **WSL** 仓库 `/home/dthree3/d3-price-monitor` 部署。WSL 看不到 Windows 进程/CDP（localhost 不互通）：查 Windows 用 `tasklist.exe`，查 CDP 用 `powershell.exe ... http://127.0.0.1:9222/json`。Windows 文件从 `/mnt/c/Users/Asus/D3-runtime/` 读。

## 数据流
PDP 接口 JSON → `src/scraper.mjs extractFromPdp()` 整理出 variants → `data/records.json`（Windows 端）→ `runOnce` 同步 → Worker `/api/sync`（`d3-worker/src/index.js`）→ D1 `variant_prices` → 前端 Dashboard。价格字段是微元(÷100000)。

---

## 进行中任务（交接重点）

> 📄 **最新一轮改动详见 [`HANDOFF-2026-06-12.md`](HANDOFF-2026-06-12.md)**（已 push）。下面是滚动状态。

### 任务 B：P2C orphan 永久修复（先清后插）— ✅ 已部署完成
- `d3-worker/src/index.js` `/api/sync`：每 item `DELETE WHERE shop_id+item_id` + `INSERT 当前变体`，同一 `env.DB.batch()`（事务原子）；无有效变体的 item 不 DELETE；price_history 不动。commit `aa82b0b`。
- **2026-06-12 已 deploy**：Worker Version `b7f7553f`。实测跑一轮 D3 all 后 `variant_prices` 2150→1748（净删 ~402 orphan）。先清后插生效。

### 任务 A：过滤页面上 disabled / 灰掉的 package 组合 — ❌ 已回退，方案不成立，待重新定信号
- 原方案（commit `42dee59`）：`extractFromPdp` 跳过 `is_grayout===true || is_clickable===false` 的 model。**已 revert（`45d8078`），WSL + C:\D3 + D3-runtime 三处 scraper 都回到无过滤。**
- **回退原因（实测）**：单抓 A06（itemId `2040352813`，**自家店 shopId 54618012「Our Store」**，不是 Spray Gadget）拿 raw 验证——75 个 model **全部 `is_grayout=false`/`is_clickable=true`**，`grayedOutCount=0`，删不掉任何东西。CLAUDE.md 旧前提「`is_grayout=true ⟺ is_clickable=false`」只在 **Tab A11** 成立，**对 A06 不成立**。
- A06 唯一能区分「占位/不可买」组合的信号是 **RM999 dummy 价**（`price=99900000` + `promotion_price=null` + `price_before_discount=0` + `promotion_id=0`，6 个）。`promotion_id==0` 单独不够（6 个真组合也是 0）。注意 Green `Promo set`=RM561.81 是**真实可买促销**（有真 promotion_id），不一定该消失。
- **待 Leon 拍板**：① 页面选 Green 后 Promo（561.81）到底灰不灰；② 信号用 RM999 占位价 / 读 DOM 置灰态 / 暂不做。Leon 原则「靠页面 disabled 状态、不靠价格」与 A06 现实（PDP 无 disabled 信号）冲突，需重新确认。

### 前端 Dashboard 三处改动（`d3-price/index.html`）— ✅ 已 push + 已部署
commit `7257135`，已 `vercel --prod` 上线（https://d3-price-seven.vercel.app ）：
1. 移除 **Urban Republic** 商家（`activeRoles` → `['A','B','C']`，删下拉 option + 图例文字；内部角色映射保留不渲染）。
2. 删除 **「Price drop report」** 版块（HTML 删除，JS 改 null-safe）。
3. **「Captured product details」默认空表**：只有搜索/店铺/系列/型号筛选或点竞品按钮才列出款式，否则空。

---

## 硬约束（勿违反）
- **Leon（零售商）拒绝任何 CAPTCHA / 反爬绕过 / 防指纹伪造工具**。只做 A/B 对照、读 DOM/接口的合法抓取，不破解。
- Worker 只部署**这份 WSL 仓库** `/home/dthree3/d3-price-monitor/d3-worker`，**不要**用 `C:\D3\d3-worker`。
- runOnce 的 `syncCloudRecords`（带 X-D3-Secret / currentPrice→price / 重试）是 Codex 修的，别动。
- 同步竞品走 `runOnce`，**不要**用 `sync-cloud-retry`（那个规整器有 bug，会把 A 系列误映射）。
- 改型号命名逻辑后需 `DELETE FROM variant_prices` 清库再重抓一圈。

## 常用命令
- Worker 部署：`cd d3-worker && npm run deploy`
- 前端部署：`cd d3-price && npx vercel --prod --yes`（git push 不触发，必须手动）
- 查 D1：`cd d3-worker && npx wrangler d1 execute d3-price-db --remote --json --command "SELECT ..."`
- 单 listing 抓取调试：scraper 跑完看 Windows 端 `out/pdp-raw.json`（原始 PDP）和 `out/last-page.png`（截图）。
