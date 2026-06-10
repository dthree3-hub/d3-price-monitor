# 修改记录 / Changelog

> 每次改动都记在这里（最新在最上面）。格式：日期 · 文件 · 改了什么 · 为什么 · commit。

---

## 2026-06-11

### 实测：不登录自动化被挡 → Chrome 默认改回登录 profile
- **文件**：`scripts/windows/start-chrome-cdp.ps1`
- **发现**：手动无痕开 Shopee 商品页能看价；但**自动化(CDP)+不登录**会被挡「Page Unavailable / Log in to continue」——登出的自动化不被信任。**不登录这条对自动化是死路**（裸调接口回 `is_login:false`/`error:90309999`）。网上「能抓」的方法几乎全是 stealth/指纹伪造/代理池/验证码求解（破解，Leon 拒绝）。
- **改了什么**：start-chrome-cdp 默认 profile 改回 `C:\chrome-cdp-d3`（登录用）。防封改靠「温柔调度」(慢/不突发/碰验证停)，不是靠不登录。
- **结论/待定**：可行路只剩 ① 登录(用小号)+温柔抓+人工解验证(免费,小风险) ② 付费 Apify(他们扛反爬,零账号风险)。封号主因是**突发全量抓**(清D1后猛抓106条)，不是登录本身——温柔版去掉了突发。Leon 在想选哪个。

### 防封改造：定时慢速 sweep + 验证人工接管
- **文件**：`src/runOnce.mjs`(新增 `runSweep`)、`src/hermes.mjs`(改定时调度器)、`scripts/windows/start-hermes.ps1`、`scripts/windows/start-chrome-cdp.ps1`、`.env.example`、`src/recovery/VerificationDetector.mjs`
- **背景**：用登录账号 + 突发全量抓导致 Shopee 检测自动化、**账号被封**。重做成「不赔账号」的模型。
- **改了什么**：
  - `runSweep({group})`：一次抓完一组(self/competitor/all)，**跨店轮流 + 各店打乱 + 每条随机 10–20 秒**，不再用 batch cursor。碰风控/封锁连续 N 次自动停。
  - `hermes.mjs` 从「连续 90 分钟 cycle」改成**定时调度**：每天 `HERMES_RUN_TIMES`(默认 09:30/13:00/16:30) 各跑一整圈；首个时段含自家店、其余只对手；**启动自动先抓一轮**(临近定时点则跳过)；每分钟轮询 `/api/trigger` 支持网页「🔄 Refresh now」手动触发；最小间隔保护防连抓。
  - **验证人工接管**：`HERMES_RECOVERY=1` + `MAX_WAIT_MIN=3` → 碰验证页暂停 + Telegram 通知，等你最多 3 分钟手动解；**没解则整轮停止**(`runSweep` 接住 `VerificationTimeoutError/AbortedError` 直接 break)。
  - **不登录**：`start-chrome-cdp.ps1` 的 profile 改成可配 `CHROME_CDP_PROFILE` → 用全新没登录 Shopee 的 profile，没账号可封；`HERMES_CDP_REUSE_TAB=1` 复用同一 tab(少开新 tab)。
  - `VerificationDetector` 认得 Shopee "Page Unavailable / account restricted / automated tools detected" 封锁页(归 ACCESS_DENIED)。
- **善后**：同步 4 个 src 文件到 C:\D3、`HERMES_RECOVERY=1`、**先验证「不登录」能否拿到价格**再切换 profile。

## 2026-06-10

### 型号/档位解析修复（Leon 数据复核 #4/#5 + S10 FE+/Lite）
- **文件**：`src/variant-parser.mjs`、`d3-price/index.html`
- **改了什么**：
  - **#4 Offer→Promo**：`extractTier` / 前端 `normalizeTier` / `canonTier` 新增 `offer→Promo`（TAC 的 A37 等用 "Offer"/"Limited Offer" 表示 Promo）。
  - **#5 A56 类 5G 去重**：前端 `normalizeModelKey` 对 5G 独有的 A 系列(A26/A36/A37/A56) 去掉冗余 "5G"，让「A56 256GB」与「A56 256GB 5G」合并（A06/A07/A16/A17 有 4G/5G 双版，保留网络）。
  - **S10 FE+ 识别**：`extractModel` S1x 正则加 `FE\s*Plus`，"S10 FE PLUS"/"S10 FE +"/"S10FE+" 都归到 `S10 FE+`，与 `S10 FE` 分开（原本 "FE PLUS" 丢 PLUS 被并进 FE）。
  - **平板 WiFi 默认**：平板款式名没写网络时默认 WiFi（基础款=WiFi，LTE/5G 都会明确标），「Tab S10 Lite」与「Tab S10 Lite WiFi」合并，LTE 款仍分开。
- **为什么**：Leon 逐条记录的数据问题。
- **善后**：含后端解析 → 需同步 C:\D3 + 重抓；#5 纯前端 → Vercel 重部署。

### 删除「Price drop report」区域
- **文件**：`d3-price/index.html`
- **改了什么**：移除整个 `Price drop report` section（含 Last updated / Largest drop 指标和降价列表），删掉 `buildDropReport`/`renderDropList`/`toMalaysiaTime` 及相关元素声明。无用的 `.report-*` CSS 保留（不匹配任何元素，无害）。
- **为什么**：老板视图用不到这个降价历史区域，Leon 要求删除。

### 逐款售罄（不可选的款式当售罄，不再显示价格）
- **文件**：`d3-worker/src/index.js`、`d3-price/index.html`
- **改了什么**：`sold_out` 列从「整个 listing 售罄」改成**逐款标记**（upsert bind 改 `v.inStock===false || rec.soldOut`）；Worker `rowsToRecords` 给每个 variant 带 `soldOut/inStock`，记录级 soldOut 改为「所有款都售罄」推导。前端 `normalizeVariant` 透传逐款 `soldOut`（兼容 inStock 形状、缺失不误判），`build()` 把逐款售罄当成不计价、标 Sold Out（自家缺货款也不计入「我们的价」）。
- **为什么**：某 listing 10 个款式有 3 个卖完(不可选)，但网页仍显示它们的价格，应标售罄。scraper 早已按 `mdl.stock===0` 逐款标 sold_out，缺的是存储和前端只用了整单售罄。
- **善后**：需重部署 worker+vercel + 清 D1 重抓。

### 百分比/额外/满减 voucher 全链路（按款式精确算）
- **文件**：`src/scraper.mjs`、`src/runOnce.mjs`、`d3-worker/src/index.js`、`d3-price/index.html`、`.agents/skills/shopee-product-detail/scripts/extract-shopee-product.py`、D1
- **改了什么**：
  - scraper DOM 提取从只认 `RM N off` 扩成每张券带回 `{fixed, percent, minSpend}`（`buildVoucherInfoExpression`/`normalizeVoucherInfo`），认 `N% off` 和 `Min. spend RM X` 满减门槛；接口无门槛固定额券(type1)合并进券列表（`mergeApiFixedVoucher`），百分比/满减以 DOM 文字为准。scraper 返回值新增 `vouchers` 数组。
  - runOnce 新增 `variantVoucherAmount(price, vouchers)`：逐款挑最优券——满减券只在该款价格 ≥ 门槛时生效，百分比取 `percent×该款价格`（5%×527≠5%×999），多张取折扣最大者，写进 `variant.voucherAmount`。记录级 `voucherAmount` 仅存无门槛固定额。
  - Worker upsert 改用 `v.voucherAmount ?? rec.voucherAmount ?? 0`（per-variant 优先）。
  - 前端 `normalizeVariant` 透传 `voucherAmount`；`build()` 的 effectivePrice 改成「逐款 voucher 优先，没有才回退每店设置」。
  - 顺手修 `shopee-product-detail` skill 的 bug：原本百分比券抓到却没算进 effectivePrice，改成每款取最优券（固定额 vs %×价），并识别 `Min. spend` 满减门槛、带回 per-variant `voucherAmount`，与生产逻辑一致。
- **为什么**：百分比券（如 Spray Gadget A06 5G 的 5% OFF）、额外固定券（如 RM50 off）、满减券（满 RM500 减 RM10）原本两条提取路径都漏或算错（满减券会无视门槛对所有款式硬扣），网页对比价不准。
- **善后**：需 `cd d3-worker && npm run deploy`、`cd d3-price && npx vercel --prod --yes`、清 D1 重抓一圈（voucher 值变了）。

### A11+ 的 "+" 不再丢失
- **文件**：`src/variant-parser.mjs`
- **改了什么**：`extractModel` 与 MODEL_PATTERNS 的 A 系列正则在型号数字后加了可选 `(\+|Plus)` 捕获组，`A11+WiFi(6+128)` / `A11 PLUS` 解析为 `Tab A11+ WiFi`（原本丢 + 变 `Tab A11`）；`normalizeCapacity` 剥型号时同步跳过 `+/Plus`，不影响 `6+128` 容量解析。普通 A11、A06 等无回归。
- **为什么**：A11 与 A11+ 是不同型号（RAM 4 vs 6），名字里有 "+"/"PLUS" 时应保留以区分。
- **善后**：型号 key 变了，需清 D1 重抓（见 [[d3-runbook]] 规则）。

---

## 2026-06-09

### 售罄(Sold Out)全链路 + 平板统一 Tab 前缀 + 只看低过我们按钮
- **文件**：`src/runOnce.mjs`、`src/lib-records.mjs`、`src/variant-parser.mjs`、`d3-worker/src/index.js`、`d3-price/index.html`、D1
- **改了什么**：
  - 记录级 `soldOut`（整个 listing 所有款式都缺货=售罄）；runOnce 计算、lib-records 保留、sync 透传、Worker 新增 `sold_out` 列存/读、前端 normalizeRecord 保留。
  - 前端 build() 标记每个(型号,店)是否「只有售罄来源」；表格显示红色 **Sold Out** 代替价格（有其他有货来源则照常显示价）。
  - 平板统一带 `Tab` 前缀（避免 `S11 Ultra` 与 `Tab S11 Ultra` 拆两行）。
  - 老板视图加「⚠ 只看低过我们」按钮，过滤出所有有对手低于我们的型号。
- **为什么**：Deal Direct A06 5G 官网已 OOS 但表格还显示 RM527，需要标售罄；平板前缀不统一导致重复行。
- **commit**：见下；D1 加 `sold_out` 列并清空重抓。

### 突发式抓取 + 网页「立即更新」按钮
- **文件**：`src/hermes.mjs`、`d3-worker/src/index.js`、`d3-price/index.html`、`C:\D3\.env`
- **改了什么**：
  - Hermes 加 `HERMES_CYCLE_GAP_MINUTES`（设 90）：批次间隔仍 1 分钟，但一整圈跑完后休息 90 分钟再开下一圈，降低反爬触发。
  - Worker 加 `/api/trigger`（POST 设标记 / GET?consume=1 读并清，用 D1 `control` 表）。
  - Hermes 休息期间每 30 秒轮询 `/api/trigger`，网页按了「立即更新」就提前开抓。
  - 前端老板视图加「🔄 立即更新」按钮，POST 到 Worker 触发端点（远程也能用）。
- **为什么**：电脑 24 小时跑时不想被反爬频繁拦；改成「抓一圈→歇1.5小时→再抓」，需要时网页按钮可随时强制抓。
- **commit**：见下

### 被反爬拦时重载重试（只慢被拦的链接）
- **文件**：`src/scraper.mjs`
- **改了什么**：CDP 读到反爬错误码(如 `90309999`)时，重载页面、等反爬 JS 跑完、再读一次，最多 `HERMES_CDP_ANTIBOT_RETRY`(默认2)次。只有被拦的链接会延迟，正常链接不受影响，批次照常快。
- **为什么**：用户想保持 8 条/批的速度，但希望被拦的 TAC 平板链接能自动通过，而不是只跳过。
- **commit**：`8825ab0`

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
