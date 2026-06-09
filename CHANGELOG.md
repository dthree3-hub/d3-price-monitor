# 修改记录 / Changelog

> 每次改动都记在这里（最新在最上面）。格式：日期 · 文件 · 改了什么 · 为什么 · commit。

---

## 2026-06-09

### 修复批次卡死（被反爬拦时跳过）
- **文件**：`src/runOnce.mjs`、`src/lib-hermes.mjs`
- **改了什么**：batch state 加 `retries` 计数；一批抓到 0 条时最多重试 2 次，超过就强制 cursor 前进跳过该批（被拦链接下一整圈再试）。
- **为什么**：第 8 批两个 TAC 平板链接一直返回 Shopee 反爬错误码 `90309999`，旧逻辑「0 条就保留 cursor 重跑」导致整个轮换永久卡在第 8 批。
- **commit**：`1d7653a`

### Price drop report：丢档数 → 最新更新时间(MYT)
- **文件**：`d3-price/index.html`
- **改了什么**：「Dropped variants」指标换成「Last updated (Malaysia)」，显示 Hermes 最近抓取的马来西亚时间(UTC+8)，新增 `toMalaysiaTime()`。
- **commit**：`3ae63a6`

### 平板 WiFi/LTE + 斜线显示 + 分类筛选位置
- **文件**：`src/variant-parser.mjs`、`d3-price/index.html`
- **改了什么**：解析器给平板(A11/S10/S11/Tab)补 WiFi/LTE/5G 网络，WiFi/LTE 款分开；前端 `displayMk()` 在存储前加斜线（`A26 5G / 256GB`）；Category 筛选移到「Full comparison table」标题上方。
- **commit**：`f324ee3`

### 老板视图：分类筛选 + 荧光黄规则修正
- **文件**：`d3-price/index.html`
- **改了什么**：① 荧光黄改成「任何对手价低过我们(我们最低价)就高亮」（原本只高亮全场最低对手）；② 老板对比表加「分类 → 型号」级联下拉框（平板 A11/S10/S11/Tab 与手机分开归类）；③ 顶部说明文字同步更新。
- **为什么**：用户要的是「对手比我们便宜就标黄」，且想按系列/平板/耳机筛选表格内容。
- **commit**：`de1762c`（已部署 Vercel）

### 批次大小 5 → 8（加快全圈抓取）
- **文件**：`C:\D3\.env`（非 git）
- **改了什么**：加 `HERMES_BATCH_SIZE=8`。
- **为什么**：106 条链接，5 条/批要 22 批（约 22–28 分钟）；8 条/批降到 14 批（约 15–18 分钟），速率只升 60%，比 10 条/批风险低。
- **注意**：盯失败率，若飙高或出验证码退回 5。

### 平板 S10/S11 型号识别（U=Ultra，FE/Lite/+）
- **文件**：`src/variant-parser.mjs`
- **改了什么**：`extractModel` 加平板 S1x 处理器（`S11U → S11 Ultra`，支持 FE/FE+/Lite/+，可省略 "Tab" 前缀）；`normalizeCapacity` 加 S1x 前缀剥离，避免 `S10+ 256GB` 把 `10+` 读成 RAM。
- **为什么**：Shopee 平板 variant 名用 `S11U` 表示 Ultra，旧解析器只认手机 `S2x`，平板被误判或漏认。
- **commit**：`01e8f41`

### 赠品套装 + Flip/Fold 识别
- **文件**：`src/variant-parser.mjs`
- **改了什么**：`extractModel` 开头剥掉 `(+赠品)` 括号（不碰容量括号 `(12+256)`）；Flip/Fold 规则的 "Z" 设为可选并支持 FE 后缀。
- **为什么**：手机 listing 带 `(+Buds Core)` 赠品后缀，被误判成 "Buds Core"；对手写 `Flip75G`（无 Z）旧规则不认。
- **commit**：`33b2b3d`

### 手机 S26U/S25U → Ultra
- **文件**：`src/variant-parser.mjs`
- **改了什么**：S 系列正则（`extractModel`、`MODEL_PATTERNS`、容量/颜色剥离）加 `U(?![A-Za-z])`，把 `S26U` 识别为 `S26 Ultra`。守卫避免误伤 "Urban" 等词。
- **为什么**：Shopee variant 名用 `S26U` 表示 Ultra，旧解析器丢掉 "U"，Ultra 被当普通 S26/S25（1TB 配不上、256/512 静默错配）。
- **commit**：`d92977d`

### Phase 2 voucher 自动检测（Worker + 前端）
- **文件**：`d3-worker/src/index.js`、`d3-price/index.html`、`src/sync-cloud-retry.mjs`
- **改了什么**：Worker 存/读 `voucher_amount`；前端 `bossRender` 从抓取数据自动填充每店 voucher 并显示 `(auto)`。
- **commit**：`3579359`

### 数据运维（非代码）
- **D1**：`ALTER TABLE variant_prices ADD COLUMN voucher_amount`；清理 A06 4G / A11+ 残留脏行；2026-06-09 全表清空（532 行）以配合解析器大改，让 Hermes 重新抓满。
- **C:\D3 .env**：加 `HERMES_CDP_ALLOW_CREATE_PAGE=1`（修 CDP「找不到 Shopee 页面」全失败）、cloud sync 配置。
- **Worker secret**：设 `D3_SYNC_SECRET`。
- **Vercel**：手动 `vercel --prod` 部署前端（非 git 自动）。
