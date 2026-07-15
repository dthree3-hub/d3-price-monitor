# 修改记录 / Changelog

> 每次改动都记在这里（最新在最上面）。格式：日期 · 文件 · 改了什么 · 为什么 · commit。

---

## 2026-07-15

### 09:30 轮撞 /verify/traffic 后进程挂死 → 恢复层 CDP 调用全部加硬超时
- **现象**：09:30:29 撞 `https://shopee.com.my/verify/traffic`，日志停在 `verification_detected`，没有 `session_saved`/`waiting_for_user`/3 分钟 timeout，进程无输出挂死 16+ 分钟，计划任务卡 Running（7-13 断更一天同模式，这次抓到卡点）。
- **根因**（`src/recovery/ResumeController.mjs`）：`verification_detected` 之后调 `adapter.captureState()`（`Page.captureScreenshot`）→ `/verify/traffic` 拦截页 renderer 不出帧时该 CDP 调用**永不 resolve 也不 reject**，`.catch()` 救不了，后面所有超时逻辑都到不了。与 7-07「scraper 卡 TMT A57 页 50 分钟」同族（无超时的 CDP await）。
- **修复**：ResumeController 新增 `withTimeout()`（默认 30s，可用 `HERMES_RECOVERY_CDP_TIMEOUT_MS` 调），包住恢复流程里全部 adapter 调用（detect / captureState / captureSession / restoreSession），超时按各自原 fallback 走（如截图拿不到就不带图通知）。C:\D3 与本 repo 已同步同一版本。
- **第二道保险**：三个计划任务 `D3 Hermes 0930/1300/1630` 设 `ExecutionTimeLimit=2h`，再挂死 Windows 会强制收掉，不会永远卡 Running 堵住排程。
- **处理**：`schtasks /End` + 杀 node(17556) + `schtasks /Run` 重跑 0930 轮补数据。

### Dashboard：A36/A56/S25 FE 128GB 下架移除 + 型号行级 ✕ 删除按钮（已上线）
- **Leon 需求**：A36、A56、S25 FE 128GB 不卖了从表里拿掉；且每行加删除按钮以后自己点着删。
- **为什么不删 D1**：竞品还在卖这些型号，删了下一轮抓取会写回来 → 只能显示层隐藏。
- **实现**（`d3-price/index.html`，deployment `dpl_HjqiCHLmXyeh4rhDTN3Z78L5uR3d`）：
  - `EXCLUDED_MODELS` 加 `a36 256gb`/`a56 256gb`/`s25 fe 128gb`（代码级，所有浏览器生效，沿用 A27 128GB 先例；恢复需改代码）。
  - 新增 **hiddenModels 行级删除**：boss 表每行型号格 hover 出 ✕（样式同 role-hide-btn），点了整行消失（含 gaps/cheaper 统计）；存 localStorage `d3_hidden_models`（每台浏览器各自生效，同 hiddenRoles 模式）；⚙ 弹窗底部「已删除的型号」区勾选恢复。build() 里与 EXCLUDED_MODELS 同两处生效（正常行 + Product Removed 行）。
  - 语法：7 个内联 script 抽出 node --check 全过。
- **键名注意**：hiddenModels 存的是渲染后的 mk（如 `S25 FE 128GB`，normalizeModelKey+capacityLabelOf 产物），大小写敏感；EXCLUDED_MODELS 是小写。

## 2026-07-07

### 09:30 轮卡死 → 重启 + 补跑 89/89 零失败
- **09:30 首轮（含自家）跑到 ~09:58 卡死**：约 950/2100 行已入库后，scraper 挂在 TMT A57 页面上 50 分钟不动（无超时、无验证页、无 abort——与 known-issues #10「慢页面」同族但这次是无限 hang，回头可给页面内 fetch 加硬超时）。卡死会连带堵死 13:00 排程（调度 await 当前轮）。
- **处理**：杀卡死进程（PID 22380）→ 重启 Hermes（`HERMES_STARTUP_SWEEP=0`）→ 手动 sweep-all 补跑 **89/89 零失败**（今天风控温和，含昨天失败的 DD Watch8）。终态：五店全新鲜、8% 规则 0 偏差。
- **实锤**：新 8% 配置被重启后的 Hermes 正确 lazy-load（09:30 轮写入的行 `spray_8pct`/cap240 全对）——「没跑过价的进程重启后读新配置」判断成立。
- **注意**：Hermes stdout 现落在 WSL 会话 task 文件（我远程起的），`out/hermes-console.log` 是旧进程的（停在 7-06 16:30），查今日轮次状态用 `out/hermes.log`（每价一行 JSON）+ D1 grabbed_at。

### 自家孤儿 4673061876 清掉（Leon 拍板）
- D1 删 76 行（A17/A27/A37/A57，不在 products.csv、停在 7-04 的旧价会混进看板）。删前备份 `~/d3-backups/orphan-4673061876-backup-20260707.json`。删后自家店 0 旧行、看板全新鲜。
- 全库逐行核对过券规则：参与比价的行 **0 偏差**（自家/Spray/TAC=8%/cap240、DD=5、TMT=8%/cap200），display=price−discount 分毫不差。Spray 剩 124 行 2026-06-11 死孤儿（price_source 空、不参与比价）未删，无害。
- A17/A27/A37/A57 若还要监控，等 Leon 给新链接。

---

## 2026-07-06

### TAC 券规则虚惊一场（改成 fixed RM5 后又还原 10%/cap240）——净变化为零
- **经过**：Leon 报「TAC 价格错」→ 先说 TAC 只扣 RM5 → 我把 `tac_10pct` 改成 `tac_fixed5`（config 三处 + D1 273 行 UPDATE 成 raw−5）→ Leon 更正**口误：扣 RM5 的是 Deal Direct**（本来就配对）→ 已全部还原：config 三处回 `tac_10pct`（与改前逐字一致），D1 273 行 UPDATE 回 `min(10%, 240)`（抽查 9999→9759 触顶 / 139→125.1 未触顶）。**Hermes 不用重启**（进程内缓存的本来就是 10% 规则）。
- **⚠️ 原始问题仍未定位**：Leon 最初看到的「TAC 价格错」具体是哪个型号还没给，待 Leon 指认后再查（TAC 数据是今天 10:33-10:57 抓的，不是 stale）。
- **副发现 ①（真 bug，待修）**：**Spray A06 5G**（item 28659330574）：页面 Green+Set A raw 666 → 券后 599.40 **可买**，但 D1 里 666 那行记成 `Black / A, available=0`，Dashboard 退到 713 的 Green/B → 显示 641.70。**券算法没错（10% 分毫不差），是变体组合/可用性抓取问题**（同族：d3-disabled-variant-rule）。
- **副发现 ②**：自家店 54618012 最新抓取停在 7-04 13:02（落后 2 天），竞品都是今天早上的；比价差价失真，待查排程为何自家店没跑。
- **副发现 ③**：TMT 98 行已是 `tmt_voucher_calculated` 带 display → 7-05 遗留的 worker deploy + Hermes 重启已完成。
- **备忘（Leon 提到但被口误撤回打断）**：如果以后确认竞品券真是按 listing 挂、按店配不准——WSL scraper 已有验证过的 `extractVouchers()`（PDP 接口逐 listing 读券定义），可走「自动读券」方案；生产 Windows scraper 是旧版没这段，动它需 Leon 明确批准（红线）。

### 深夜终局：自家/Spray/TAC 全部 8%/cap240 + 夜间全量重抓 88/89 + Spray Set 修复生效实锤
- **Leon 最终口径（以此为准）**：自家店、Spray、TAC 三家都是 **8% off / cap RM240**（不是 10%）；TMT 8%/cap200/min100 不变；Deal Direct fixed RM5 不变。config 三处已全改（`d3_8pct`/`spray_8pct`/`tac_8pct`）。
- **夜间 sweep-all 88/89**（约 23:15-23:55）：TAC/TMT 全量新鲜；唯一失败 Deal Direct Watch8 listing 19273412472（加载超时，非风控，下轮自动补）。sweep 进程启动早于自家/Spray 改 8% → 这两家的行按旧 10% 入库，**已 D1 UPDATE 重算 1402 行**成 8%/cap240（price≥50 才扣）。终态验证：五店有效折扣率 self/spray/tac/tmt=0.080、DD≈fixed5，全对。
- **Spray Set 解析修复生产实锤**：A06 5G 现在 Set A(666→612.72，Green available=1)/Set B(713→655.96)/Set C 独立成行，覆盖问题消失。
- **Hermes 不需要再重启**（新进程跳过了启动抓取 → 引擎 lazy-load 还没缓存 config → 明早 09:30 首次算价时读的就是全 8% 新文件）。
- **待办**：min_spend=50 沿用假设未实锤；明天可拿抓回的 voucher_amount 与页面对账。Promo vs Promo(+15W Charger) 合并覆盖问题仍待 Leon 拍板。

### 深夜：TAC 券真相=改成 8%/cap240 + Spray 单字母 Set 解析修复 + Hermes 重启
- **TAC 券规则（Leon 口头确认）**：TAC 的券**从 10% 变成 8% off / cap RM240** ——这才是今天最初「TAC 价格错」的真正根源（上午的 fixed5 是口误）。`config/voucher-rules.json` 三处改 `tac_8pct`（min_spend 沿用 50 假设）；PDP 实锤两次被反爬拦(90309999,深夜风控紧)未验，明天可用抓回的 voucher_amount 对账。D1 273 行已重算（Fit3 139→127.88 即 8%、Z Fold7 9999→9759 触顶），Dashboard 立即生效。
- **Spray A06 变体覆盖 bug 修了（`src/variant-parser.mjs` extractTier，C:\D3+WSL+runtime 三份）**：Spray 的 Set 选择器就叫「A/B/C」单字母，`dims.join(' / ')` 后名字如「5G (6+128GB) Green / B」解析不出 tier → 同色 Set A/B/C 在 6-key 撞车互相覆盖（Green 的 Set A 666 被 Set B 713 压掉 → Dashboard 显示 641.70 而非 599.40）。修法：结尾 `/ [A-E]` → `Set A/B/C`（避开手表表带 S/M/L）；离线验证 10 个真实名字全对、Promo/手表不受影响。**旧空 tier 行不用手动清**：worker /api/sync 是先删后插（per item），明早 09:30 重抓自动换新 key。
- **⚠️ 遗留（要 Leon 拍板）**：`Promo` 和 `Promo(+15W Charger)` 仍按旧规则同归 Promo tier → 同色两个不同价的 Promo 互相覆盖（Spray Grey 691 被 744 压掉过）。改的话要动「Promo/Promo1 统一归 Promo」这条 Leon 定的老规则，没批不动。
- **Hermes 已重启（Leon 批准）**：杀旧 PID 8084 → 从 D3-runtime 按 start-hermes.ps1 同款 env 重启（新 PID 22380），`HERMES_STARTUP_SWEEP=0` 跳过深夜启动抓取（风控紧+白天数据新），明早 09:30 排程首轮（含自家店）自动用新 8% 规则+新解析器全量重写。
- **代码漂移备忘**：WSL `variant-parser.mjs` 比 C:\D3 多一段「平板 LTE 保留/手机 LTE→4G」逻辑（C:\D3 没有）——本次没动这个差异，两边各自打了 extractTier 修复。以后对齐时注意这段是 WSL 独有新修复，别被 C:\D3 旧版覆盖。

### 下午：自家店断更修复 + 全量重抓（88/89），「TAC 错价」真相=自家数据陈旧
- **自家店断更真因（两层）**：① 今早 09:30 排程轮**抓到了**自家店但云端同步没推上去（后来手动 sweep 收尾的 sync 把 records.json 里 09:58 的数据补推进 D1）；② 自家只在 09:30 'all' 轮抓，13:00/16:30 只抓竞品 → 一旦 09:30 轮掉链子，自家一整天陈旧。
- **过程**：3 轮 sweep-self（第1轮 0/16 验证页超时停;第2轮 6/16;第3轮 3/16）+ Leon 解验证数次;期间误判过一次「13:00 轮卡死」——实际它整轮跑完才同步（1248 行竞品）,别用「D1 没动静」判轮子死活。之后 Leon 关了 Chrome → 杀残留 node(⚠️ TaskStop 只杀 WSL 侧 powershell 桥,Windows node 会孤儿,要 `Get-CimInstance Win32_Process` 找 PID 精杀,别动 hermes.mjs 那个) → 远程重启 CDP Chrome（leon profile）→ **sweep-all 全量 88/89 成功**（唯一失败: Spray A17 5G 单品 26990633665, page_fetch 网络错,16:30 轮自动补）。五店全新鲜: self 631/DD 238/Spray 606/TAC 273全/TMT 98全。
- **WSL 远程跑 Windows sweep 的配方**：`powershell.exe -NoProfile -Command 'Set-Location C:\D3; $env:HERMES_SCRAPE_MODE="cdp"; ...(start-self.ps1 里那套 env)...; node --env-file=C:\D3\.env .\src\sweep-self.mjs'`（`-ExecutionPolicy Bypass -File` 会被权限拦,用 -Command 内联同样的 env 即可;sweep-all.mjs 同理）。起 Chrome: `Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=C:\chrome-cdp-d3-leon",...`。
- **🔴 新发现孤儿**：自家 item **4673061876**（A17/A27/A37/A57）**不在 products.csv**（72 行清单里没有）→ D1 里 76 行永久停在 7-04,怎么跑都不刷新。**待 Leon 拍板删**（他有孤儿行不清理的旧规矩,故未动）。
- **待修（已在上午记录）**：Spray A06 5G 变体可用性 bug（666 Set A 页面可买但 D1 记成 Black/A available=0 → Dashboard 显示 713 档的 641.70）。
- **结论**：全天折腾的根源不是任何店的券算法错——是**自家数据断更两天把 Gap 全比歪了** + 一个孤儿 listing 永久陈旧。

### 新竞品 TMT（Thunder Match，shop 11823178）接入 — intake 链路首次真实跑通
- **来源**：Leon 在 Product Intake 网页加了 **18 条 TMT listing**（S26 系/Z 系/A 系/Tab/Watch/Buds 4）→ 云端 `/api/intake` → Hermes sweep 自动合并（`base=71 intake_remote=18 merged=89`）。**products.csv 没动**，TMT 只活在 intake。
- **前端**（`d3-price/index.html`，已 `vercel --prod`）：TMT 注册为角色 **E**——`SHOP_ROLE_BY_SHOP`/`ROLE_LABELS`/`SHOP_NAME_FALLBACK`/`ROLE_NAMES`/`SHOP_ROLES` 5 处映射 + watchlist 下拉。
- **券规则**（`config/voucher-rules.json` 三处：WSL/C:\D3/D3-runtime）：`tmt_8pct` = **8% / cap RM200 / min_spend RM100** → `tmt_voucher_calculated`。**已拿真实 PDP 验证**：TMT A36 `final_price_info` 券 ABW3COFI 折扣 RM131.92 = 1649×8% 一分不差；PDP `shop_vouchers` 字段自带 8%/cap RM200/min RM100，与 Leon 截图一致。⚠️ 该券 valid till **14.07.2026**，到期换券改这一处配置即可。
- **comparable 白名单三处加 `tmt_voucher_calculated`**：`src/voucher-engine.mjs`（三份都改）、`d3-worker/src/index.js` COMPARABLE、`d3-price/index.html` priceSourceOf。
- **抓取**：Hermes 重启（机器重启后进程没了；直接 node 启动保 patch），startup sweep **73/73 零失败**，TMT 18 条全进 D1（raw + `need_voucher_check`，Need Check 标）。顺带恢复了 6-29 被风控停更的全部竞品价。
- **⛔ 未完成（下次先做）**：① `wrangler login`（WSL OAuth 过期，Cloudflare 2FA 验证码发公司电话，Leon 暂拿不到）→ ② deploy worker → ③ **再**重启 Hermes 载入 tmt_8pct（引擎缓存 config，顺序铁律：先 worker 后 Hermes，反了会出「calculated 但 display 被旧 worker 洗 NULL」脏状态）。
- **顺手修**：WSL 主 worktree 的 `d3-worker/src/index.js`/`src/voucher-engine.mjs`/`config/voucher-rules.json` 落后线上（6-27 从 d3-release worktree 部署导致），已对齐——以后从主 worktree 部署不会回退 Deal Direct 修复。
- **待办**：Telegram bot `price-lookup.mjs` 的店名映射/竞品正则未加 TMT（bot 目前 down + 静音，恢复时一起）。Leon 已同意方向未开工：每轮自动核对「PDP 券后价 vs 引擎算的价」，不一致告警（自动发现换券）。

### Dashboard：竞品显示开关（藏 TMT 给老板看）
- **需求（Leon）**：老板没批 TMT 比对，报价演示时要能把 TMT 藏掉；最低价也要能勾选哪些对手参与。
- **实现**（`d3-price/index.html`，已 `vercel --prod`）：`hiddenRoles` Set 存 localStorage `d3_hidden_roles`；`bossRender` 开头 `activeRoles = ALL_COMP_ROLES.filter(...)` → 列/👑最低价/Gap/🔥计数/图例/描述行全自动跟随。UI：对手列标题 **hover 出隐形 ✕**（点=藏）；「👑 Lowest competitor」旁淡色 **⚙** 弹勾选框（恢复入口）。
- **边界**：只显示层、只本机浏览器生效（老板自己开网址看到全部）；抓取/D1/比价数据不受影响。

---

## 2026-06-15

### Take Back 接入手表/Buds/Fit + 切到公司共享表
- **文件**：`d3-worker/src/index.js`、`d3-worker/wrangler.toml`
- **改了什么**：
  - `parseSkuKey` 加 `WATCH/BUDS/FIT` 分支：去 `(L320)`/`(R410)` 代号 + 颜色/GIFT 尾巴；Watch→`Watch {num}[ Classic][ 44mm][ BT|LTE]`（Ultra→`Watch Ultra[ 年份]`），Buds/Fit→去代号后整串即 key。输出对齐 dashboard `variant.model`（scraper 已解析出 `Watch 8 40mm BT` 这种）。
  - `wrangler.toml` `GOOGLE_SHEET_ID` 从旧副本 `1CWnB3...PITY` 切到**公司真正共享表**「Market Price List」`1sx6Q7...07xI`（手表只在公司表里）。手表数据在 Samsung tab 的 SMART WATCH/FIT 段（r91+），H 列 = Take back (S)。
- **为什么**：旧 `parseSkuKey` 只认手机(RAM+存储)和平板(`^S1[01]`)，手表无 RAM+存储 → `return null` → 整行被丢，Take Back 一直显 `—`。
- **业务决定（Leon 2026-06-15）**：① 切公司表（手机/平板 take back 数值随之变成公司表最新值）；② 同型号不同颜色 take back 不同时（如 Watch 8 Classic 黑/白）按 first-wins 取表上第一个（黑）；③ `WATCH ULTRA (L705)` 2024 款映射成 `Watch Ultra`，不补单独的 `Watch Ultra 2024` 行。
- **验证**：`/api/csp` count 54→71，17 个手表/Buds/Fit key 全现、数值与表一致。
- **commit**：见本次 · **Worker Version `f8038248`**（已部署）。
- 注：index.js 同时带上之前未提交的「take back 行改对象 `{takeBack,csp,commission,ccb,ads}` + `toNum()`」（结构化 breakdown，早前已随部署上线）。

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
