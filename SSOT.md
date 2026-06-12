# D3 Price Monitor — SSOT (Single Source of Truth)

> Claude 和 Codex 的共同参考文件。所有已决定的事不重复问，直接查这里。
> Last updated: 2026-06-12（本周由 Claude 完成数据准确性整治，见第 0 节交接）

---

## 给 Codex 的说明

每次开始任务前先读这份文件。它记录了分工边界、冻结区、当前项目状态、数据格式规范。
如果你的工作会影响数据格式、型号命名、价格规则，**先更新这份文件再动代码**。

---

## 0. 2026-06-11/12 最新进度交接（Claude → Codex）

> 本周 Claude 完成的「数据准确性整治」。Codex 接手请先读本节。背景细节也在 Claude 自动记忆（WSL `~/.claude/projects/-home-dthree3/memory/d3-*.md`）。

### 0.1 本周已完成（已部署/已验证，勿重复做）
- **解析层**（`src/variant-parser.mjs`）：修 S10 FE+→FE、S25+→S25、LTE→5G、S25 FE 混入 S25；3383 变体 0 mismatch。
- **records.json 去重**：593→76（按 shopId:itemId 留 grabbedAt 最新）。
- **D1 容量+颜色塌缩（核心修复）**：`variant_prices` 表 UNIQUE 从 4-key 改成 **`UNIQUE(shop_id,item_id,model,tier,capacity,color)`** 6-key + 新增 `color`/`variant_name` 列；Worker `/api/sync` 的 ON CONFLICT、INSERT、`/api/records` SELECT 同步改。救回 ~386 个被覆盖的 SKU 价格行。库内备份表 `variant_prices_old`、`variant_prices_pre_color`；整库 export 在 `d3-worker/backups/`。
- **前端**（`d3-price/index.html`，已部署 d3-price-seven.vercel.app）：
  - `normalizeModelKey`：S25 5G→S25 合并；**S10/S11 裸名补 `Tab` 前缀**（竞品「S10 FE」「S11」并入「Tab …」）。
  - **price_mode 开关**：默认「挂牌价」= 原价 − 通用封顶券（`10% capped RM5 · min spend RM50` → 每件实减 RM5，`universalVoucherDiscount`）；net 模式扣抓到的全部券（含未封顶/需领取，仅参考）。
  - 型号排序：FE→Base→+→Ultra，容量 128→256→512→1TB。
- **可穿戴代码优先 (P1)**（`src/variant-parser.mjs` + `src/samsung-master.mjs`）：raw 含 L320/L325/L330/L335/L500/L505/L705/R540/R640 直接定型号(confidence=confirmed)，不靠标题。canonical：Watch 8 40mm BT/LTE、Watch 8 44mm BT/LTE、Watch 8 Classic 46mm BT/LTE、Watch Ultra 2025、Buds 4、Buds 4 Pro。**仅可穿戴，手机/平板不动**（`lookupWearableByCode` 过滤）。
- **抓到并修的 bug**：`sync-cloud-retry.mjs` 的 `officialModelFor` 在**混合 A 系列 listing** 误映射（A36→A26 5G、A37→A17，损坏自家数据）。改用 `scripts/raw-sync-self.mjs`（原样推 v.model）。
- **Coverage 修复**：自家 listing `5276526599`（含 S25+ 512GB）曾被去重移除→加回 products.csv；保留 `27874385975`（含 S25 Ultra 1TB）。已跑 D3 only 重抓 16 条自家、同步、去重。
- **P1 — TAC 手表简写解析**（`src/variant-parser.mjs`，commit `34b4d13`，已 push main）：竞品 TAC listing `C-9812470630` 变体用极简写——`W8`/`W6`=Watch 8/6、`W8 CLASSIC`=Watch 8 Classic、`W ULRA`=Watch Ultra（卖家把 ULTRA 拼成 ULRA）、`BH`=蓝牙(BT)、`LTE`、40/44/46MM。旧 parser 无厂方码、也不匹配 `Watch N` 正则 → 回退营销标题成垃圾 model。新增**严格门控** `resolveTacWatchShorthand`（仅款式名以 `W6/W8/W ULRA` 开头才触发；手机 S/A/Z、平板 Tab/S1x 绝无此开头，不受影响）。映射：W8 BH 40/44MM→Watch 8 40mm/44mm BT(对上 master L320/L330)、W8 CLASSIC BH→Watch 8 Classic 46mm BT(L500)、W ULRA LTE 2025→Watch Ultra 2025(L705)；**Watch 6 / Watch Ultra 2024 自家不卖→干净标签但不进 master**（Leon 确认）。全库扫描验证门控只命中此 listing(28 变体×2 轮)、解析后全 watch 品类、0 误伤手机/平板。
- **P2 — TAC 手表重抓 + D1 残留清理**：用新 parser 跑 D3 all（2026-06-12 08:20，抓 70/71、失败 1=Spray Gadget A37 5G 反爬 90309999；同步去重 227→71、云端同步成功 71 条）。TAC `9812470630` 在 records.json + D1 + Dashboard 三处一致 = **28 条干净手表型号**。**6-key 副作用**：新 model 与旧垃圾 model 键不同 → 旧 22 行成孤儿残留（updated_at 06:44:49 未被覆盖）。按安全流程（COUNT→列样本→限定 DELETE→复查）清掉：`DELETE FROM variant_prices WHERE item_id='9812470630' AND model LIKE '(READY STOCK)%'` → 删 22 行、剩 28 干净、Dashboard 无垃圾标题。**仅删此 listing 的垃圾 model 行，未碰新行/其它 item。**

### 0.2 当前数据状态
- 自家手机/平板：审计 0 异常。`S25 512GB`=RM3559、`S25+ 512GB`=RM4135、各容量(256/512/1TB)+各颜色全保留。
- 自家可穿戴：Watch 8 各细分 / Watch Ultra 2025 / Buds 4 / Buds 4 Pro 已进 D1。带码 listing→具体型号；无码无连接信息的变体（如「Watch8 40mm Graphite」）→ 泛型「Watch 8」（无信息可细分，正常）。
- **竞品 A/B/C：已用新解析器重抓**（2026-06-12 08:20 D3 all，70/71，同步 71 条）。D1 max_updated `2026-06-12 08:20:03`。例外：Spray Gadget A37 5G (`54857330691`) 本轮反爬失败未刷新，仍旧数据。
- **⚠️ D1 孤儿行**：6-key UNIQUE 下，凡「model 解析结果变了」的 listing，旧 fallback model 行不会被新行覆盖→残留孤儿（TAC 手表那 22 条即此类，已清）。**全库规模未知，见 0.3 P2B 审计**。

### 0.3 待办（给 Codex）
- ~~**P2**：竞品(A/B/C)用当前解析器正常重抓~~ **✅ 已完成**（2026-06-12 08:20 D3 all，70/71，同步 71，走 runOnce 原样同步）。**遗留**：① Spray Gadget A37 5G `54857330691` 反爬失败未刷新，需补抓一次；② 其它 listing 的 D1 孤儿行未排查 → P2B。
- **P2B — D1 孤儿行审计（只审计，勿删/勿改 D1）**：6-key 副作用会让任何「model 解析结果改变」的 listing 留下旧 fallback model 孤儿行（如 TAC 手表那 22 条）。**先摸清规模，不全库清理。** 统计：① 有多少 item_id 同时存在「新 model」+「旧 fallback model(垃圾标题/营销串)」；② 列 Top 20 最严重案例（`item_id` / `shop` / `old rows` / `new rows`）。**只出 audit report，不 DELETE、不改 D1。** 老板要先知道问题规模再决定是否清理。
- **records.json 累积**：每轮 D3 only 会按 item 累积重复（旧记录可能覆盖新记录→D1 grabbed_at 偏旧）。**根治**：在 runOnce 同步前加「每 shopId:itemId 留 grabbedAt 最新」去重。临时手动：`node scripts/raw-sync-self.mjs <去重后的自家records>`。
- **A16 4G/5G**：在 master 但全链路无数据，确认是否在售/该监控。
- **sync-cloud-retry.mjs**：`officialModelFor` 混合 listing 误映射，修或弃用。

### 0.4 红线（勿违反）
- runOnce 的 `syncCloudRecords`（Codex 修的：带 `X-D3-Secret` / `currentPrice→price` / 4 次重试）**别动别删**。
- Worker 只部署 WSL 版 `~/d3-price-monitor/d3-worker`（`npx wrangler deploy`），**别用 `C:\D3\d3-worker`**（旧、会覆盖线上 sold_out 逻辑）。
- 别 rotate / `wrangler secret put` `D3_CLOUD_SYNC_SECRET`；别改 `.env` 的该 secret。
- 重推数据用 `scripts/raw-sync-self.mjs`，**别用 `sync-cloud-retry.mjs`**（会损坏混合 A 系列）。
- 老板拒绝 CAPTCHA/反爬绕过工具；只能人工接管（`src/recovery`）。

### 0.5 常用命令
- D3 only（自家重抓+同步）：双击桌面「D3 only」或 `powershell -ExecutionPolicy Bypass -File C:\D3\scripts\windows\start-self.ps1`（自动起 Chrome CDP:9222，需小号已登录；撞 captcha 人工点一下即自动续跑）。
- 原样重推自家：`cd /mnt/c/D3 && node scripts/raw-sync-self.mjs <records.json>`（必要时先 `DELETE FROM variant_prices WHERE shop_id=<id>`）。
- 部署 Worker：`cd ~/d3-price-monitor/d3-worker && npx wrangler deploy`。
- 部署前端：`cd ~/d3-price-monitor/d3-price && npx vercel --prod --yes`。
- D1 远程查询：`cd ~/d3-price-monitor/d3-worker && npx wrangler d1 execute d3-price-db --remote --json --command "<SQL>"`。
- 审计 v2：`cd /mnt/c/D3 && node scripts/gen-audit-v2.mjs && python3 scripts/audit_xlsx_v2.py /tmp/audit_v2.json <out.xlsx>`。

### 0.6 ⚠️ 两个 clone 不同步
本周改动分散在**两个工作副本**（同一 GitHub repo）：**解析器/scraper 改在 `C:\D3`（Windows）**；**前端/worker 改在 `~/d3-price-monitor`（WSL）**。两边各有未提交改动，**尚未 git commit/push**。Codex 接手前请先确认要不要把两边改动提交、合并、push 到 GitHub，否则两副本会越漂越远。

---

## 1. SSOT 文件路径

| 环境 | 路径 |
|------|------|
| WSL（Claude） | `/home/dthree3/d3-price-monitor/SSOT.md` |
| Windows（Codex） | `C:\D3\SSOT.md`（与 GitHub 同步） |

> ⚠️ 两边是同一份文件（同一个 GitHub repo），改一边记得 git push/pull 同步。

---

## 2. 当前线上 URL

```
https://d3-price-seven.vercel.app
```

> 原 `d3-price.vercel.app` 已从旧账号（sarahng929）迁移至公司账号（d3-s-projects），
> 新的 canonical URL 是 `d3-price-seven.vercel.app`。老板书签需更新。

---

## 3. 路径对照

| 环境 | 路径 |
|------|------|
| WSL（Claude） | `/home/dthree3/d3-price-monitor` |
| Windows（Codex） | `C:\D3` |
| 家里电脑 | `/home/sarah/...` |

---

## 4. 分工（不得交叉）

| 负责方 | 范围 |
|--------|------|
| **Claude** | `d3-price/index.html`（全部）；`d3-price/api/data.js`；`d3-worker/`（Cloudflare Worker）；git push 到 GitHub；Vercel deploy |
| **Codex** | `src/` 抓取逻辑、CDP、PowerShell、`C:\D3` Windows 侧；Hermes 可靠性；云端同步写入；Telegram bot |

> ❌ Claude 不动 `src/`。
> ❌ Codex 不动 `d3-price/index.html`。

---

## 5. 冻结区（绝对禁止修改）

### src/ 层（Codex 也不能动）
- `src/variant-parser.mjs`
- `src/lib-records.mjs`
- `src/runOnce.mjs`（`isDirectRun` 用 canonicalized path 比对，不能改回 URL 字符串）
- `src/scraper.mjs`

### 前端逻辑层（Codex 不能动 index.html，Claude 也不能随便改以下逻辑）
- `capacityLabelOf`：只保留 Storage，不保留 RAM（`8+256GB → 256GB`），不可改回
- `afterVoucher`：全局 **-RM5** after-voucher 统一规则，不可改
- `SHOP_ROLES` / `ROLE_NAMES`：shopId → 角色映射，不可改
- `TIER_ORDER = ['Basic', 'Promo', 'SET A']`：固定档位顺序，不可改

### 数据规则层
- Pantry 保留最新 120 条规则
- shopId → name fallback 映射

---

## 6. 竞品 Shop ID（锁定）

| 店名 | Shop ID | 角色 |
|------|---------|------|
| Our Store | 54618012 | self |
| Deal Direct | 116917349 | A |
| Spray Gadget | 77792787 | B |
| TAC Mobiles | 271823454 | C |

> ~~Urban Republic (56447030)~~ — 已移除（2026-06-09），不再监控。Codex 需从 watchlist 删除。

---

## 7. 数据源

**当前线上数据源：Cloudflare D1 + Workers（2026-06-09 从 JSONBin 迁移）**

> ~~Pantry~~（HTTP 522 永久挂掉）→ ~~JSONBin~~（Free Plan 100KB 限制，938KB payload 触发 403）→ **Cloudflare D1**（无大小限制，SQLite 结构化存储）

### 架构图

```
Windows (Hermes)
  └─ POST /api/sync + X-D3-Secret header
       └─ Cloudflare Worker (d3-price-worker.dthree.workers.dev)
            ├─ UPSERT → D1 (variant_prices table)
            └─ INSERT → D1 (price_history table, 仅价格变动时)

Browser (Boss)
  └─ GET https://d3-price-seven.vercel.app/api/data  (Vercel proxy)
       └─ GET /api/records  (Cloudflare Worker)
            └─ SELECT → D1 variant_prices
```

### Cloudflare D1 数据库

| 项目 | 值 |
|------|-----|
| Database Name | `d3-price-db` |
| Database ID | `2637fd89-4284-436d-b076-a6c3a530664f` |
| Worker Name | `d3-price-worker` |
| Worker URL | `https://d3-price-worker.dthree.workers.dev` |

### Worker Endpoints

| Method | Path | 说明 | 权限 |
|--------|------|------|------|
| GET | `/api/records` | 返回 `{records:[...]}` 兼容前端格式 | 公开 |
| POST | `/api/sync` | Hermes 写入，upsert variant_prices | `X-D3-Secret` header |
| GET | `/api/history?model=S25+256GB` | 价格历史，最近 500 条 | 公开 |

### 前端读取（Vercel proxy）
```
GET https://d3-price-seven.vercel.app/api/data
```
- Vercel env var `D3_WORKER_URL=https://d3-price-worker.dthree.workers.dev`
- 前端每 **3 分钟**自动 fetch 一次
- 前端有 **localStorage 缓存**（key: `d3-records-cache`）：打开页面立即显示上次缓存

### Hermes 写入
```
POST https://d3-price-worker.dthree.workers.dev/api/sync
Headers:
  X-D3-Secret: <见 D3-runtime\.env 的 D3_CLOUD_SYNC_SECRET>
  Content-Type: application/json
Body: { "records": [...] }
```
- 保留最新 **120 条**规则不变（`sync-cloud-retry.mjs` 中 `maxRecords=120`）
- Hermes .env 需要：`D3_CLOUD_RECORDS_URL` + `D3_CLOUD_SYNC_SECRET`

> ~~JSONBin bin ID: `6a277a33f5f4af5e29cf0375`~~ — 已废弃，不再使用。

### D1 Schema

```sql
CREATE TABLE IF NOT EXISTS variant_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '', sku TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '', capacity TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '', price REAL,
  platform TEXT NOT NULL DEFAULT 'shopee',
  grabbed_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(shop_id, item_id, model, tier)
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
  sku TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL DEFAULT '', price REAL NOT NULL,
  platform TEXT NOT NULL DEFAULT 'shopee',
  grabbed_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> `/data/records.json` 是 Hermes 本地文件，**不是线上数据源**。云端以 D1 为准。

---

## 8. Full Comparison Table 当前栏位（最终版）

```
Model | Our Price | Deal Direct | Spray Gadget | TAC Mobiles | 👑 Lowest Competitor | Gap | Take Back
```

- **CSP 栏已移除**：不显示在表格。CSP 数据仍存在 localStorage（key: `d3-boss-csp-price-v1`），供 Take Back 计算用
- **Gap** = Our Price − Lowest Competitor Price（负数=对手便宜，红色显示）
- **Take Back** = Lowest Competitor Price − CSP（正数=有利润空间，绿色）
- **⚠ 标记** = 无法匹配 Samsung 官方型号，需人工核查
- **🔍 按钮** = 展开该型号所有 Shopee 来源（商品标题 + 链接）

---

## 9. Hermes 抓取侧 Variant 命名规范（Codex 需遵守）

| 项目 | 规范 | 错误示例 | 正确示例 |
|------|------|---------|---------|
| Storage | 只写 Storage，不写 RAM | `8+256GB` | `256GB` |
| 连接类型 | 以 Excel 为准；A 系列手机的 LTE 写 4G，Excel 原始资料保留 LTE 的品类不强改 | `A17 LTE` | `A17 4G` |
| Set 档位 | tier 存 `"A"` 或 `"Set A"` 均可 | `"set_a"` | `"A"` 或 `"Set A"` |
| Galaxy 前缀 | 不需要加 | `Galaxy A07` | `A07` |

> 前端会自动 normalize：`LTE→4G`、`Galaxy/Samsung` 前缀去除、RAM 剥离。
> 但抓取侧统一更干净，避免产生重复型号行。

### 型号标准化补充（2026-06-08）

- 型号名称优先采用 Excel 原始资料：`C:\Users\Asus\Downloads\Market Price List.xlsx` 的 `Samsung` sheet。
- 允许做格式统一：Storage 只保留容量、A 系列手机 `LTE→4G`；Excel 原始资料明确保留 LTE 的品类（如部分 Tab/Watch）不强改。
- 不得删除官方系列后缀：`FE`、`+ / Plus`、`Ultra`、`Fold`、`Flip` 必须保留。
- 不得自行创造 Excel 不存在的型号：例如 `A17 Plus`、`A17 Ultra` 禁止生成。
- 若 Excel 只有 `A17 4G 256GB` 和 `A17 5G 256GB`，网页只能显示这两行；不得改写成其它 A17 变体。

### 型号 / tier 标准化补充（2026-06-09）

- A 系列混卖 listing 中，variant 自带的网络制式优先级最高：variant 写 `LTE/4G` 必须归到 `Axx 4G`，variant 写 `5G` 必须归到 `Axx 5G`，不得被 `our_product` 或标题里的第一个型号覆盖。
- Spray Gadget 的 2D variant 名称中，`A/B/C` 视为 Set 档位，`Offer` 视为 `Promo`，`Offer(Gift Set)` 视为 `Promo(Gift Set)`。
- Pantry 上传前的 retry uploader 负责清洗旧 records：只改标准化字段，不丢弃 Shopee PDP 已返回的 2D 组合。

---

## 10. Codex 当前优先修复顺序

### 优先级 1（影响数据完整性）
**Spray Gadget 2D Variant 没有完整抓取**
- 问题：Spray Gadget 商品有两层选择（MODEL×COLOR 和 Set A/B/C/Promo）
- 现状：Pantry 只有 Promo 价格，Set A 完全没有数据
- 要求：确保 Hermes 抓取 2D variant 时，遍历所有 Set 组合（A、B、C、Promo），不只抓默认选中的那个

### 优先级 2（型号命名）
**LTE 命名统一**
- 现状：部分型号抓出来是 `"A17 LTE"`
- 要求：存成 `"A17 4G"`，或确认前端 normalize 足够（目前前端已有 LTE→4G 转换）

### 优先级 3（可靠性）
- 确认 Hermes 常驻抓取稳定（每 3 分钟一批）
- 确认 Pantry 写入成功率

---

## 11. 部署流程

```bash
# 前端改动（Claude 做）
cd /home/dthree3/d3-price-monitor/d3-price
npx vercel deploy --prod --yes
```

```powershell
# 抓取（Codex/Windows 做）
C:\D3\scripts\windows\start-chrome-cdp.ps1   # 启动 CDP Chrome
C:\D3\scripts\windows\start-hermes.ps1        # 常驻抓取
```

### Cloudflare Worker 部署（一次性，已完成）

```bash
# WSL / Linux
cd /home/dthree3/d3-price-monitor/d3-worker
npm install

# 1. 建立 D1 数据库（已做，database_id 已填入 wrangler.toml）
wrangler d1 create d3-price-db

# 2. 初始化 Schema
npm run db:init   # wrangler d1 execute d3-price-db --file=schema.sql --remote

# 3. 设置写入 secret（只需做一次）
wrangler secret put D3_SYNC_SECRET

# 4. 部署 Worker
npm run deploy    # wrangler deploy
# Worker URL: https://d3-price-worker.dthree.workers.dev
```

**Hermes .env（`C:\Users\Asus\D3-runtime\.env`）需要：**
```
D3_CLOUD_RECORDS_URL=https://d3-price-worker.dthree.workers.dev/api/sync
D3_CLOUD_SYNC_SECRET=<Worker secret>
```

**Vercel env var：**
```
D3_WORKER_URL=https://d3-price-worker.dthree.workers.dev
```

---

## 12. 费率常数

| 项目 | 值 |
|------|-----|
| Shopee 佣金 | 10.26% |
| Lazada 佣金 | 18.36% |
| SST | 8% |
| CCB | MIN(CSP × rate × 1.08, RM108) |

---

## 13. 已知技术债

- `d3-price/index.html` ~line 2424–2508：前端猜型号逻辑，cleanup 未定
- 利润页未覆盖耳机 / 手表（不同佣金率）
- Watch 型号拆分（L320/L330/L705N/L500 代号表）待真实数据核对后再写规则

---

## 14. 2026-06-08 今日变更记录

| 变更 | 负责方 | 内容 |
|------|--------|------|
| Status bar | Claude | `~/.claude/statusline-command.sh`，改用 python3 替代 jq |
| Full Comparison Table | Claude | fixed layout、固定栏宽、新增 Take Back |
| 移除 CSP 栏 | Claude | 不显示，数据保留在 localStorage |
| 栏位顺序 | Claude | Lowest → Gap → Take Back |
| 型号标准化 | Claude | `normalizeModelKey`：LTE→4G；`modelSortKey`：按系列排序 |
| 型号验证 | Claude | ⚠ 标记未知型号 |
| Shopee 调试按钮 | Claude | 🔍 展开来源标题 + 链接 |
| Pantry 加载优化 | Claude | localStorage 缓存 + 刷新间隔 60s→3 分钟 |
| Set A 修复 | Claude | `canonTier` 新增 `t === 'a'` → SET A |
| Vercel 迁移 | Claude | 公司账号 d3-s-projects，URL: d3-price-seven.vercel.app |
| SSOT 建立 | Claude | 本文件 |

---

## 16. 2026-06-09 迁移变更记录（Cloudflare D1）

### ~~JSONBin 阶段（已废弃）~~
JSONBin Free Plan 单 bin 限制 100KB，实际 payload 938KB → HTTP 403。决定彻底移除。

### Cloudflare D1 迁移（当前）

| 变更 | 负责方 | 内容 |
|------|--------|------|
| D1 数据库 | Claude | `d3-price-db`，ID `2637fd89-4284-436d-b076-a6c3a530664f` |
| Cloudflare Worker | Claude | `d3-price-worker`，`d3-worker/` 目录，`schema.sql` + `src/index.js` |
| Worker 端点 | Claude | GET `/api/records`、POST `/api/sync`、GET `/api/history` |
| `sync-cloud-retry.mjs` | Claude | 改为 POST + `X-D3-Secret` header，移除所有 JSONBin 代码 |
| `d3-price/api/data.js` | Claude | 改为代理 Worker `/api/records`，移除 JSONBin proxy |
| Vercel env var | Claude | `D3_WORKER_URL=https://d3-price-worker.dthree.workers.dev` |
| Hermes .env | User | `D3_CLOUD_RECORDS_URL` + `D3_CLOUD_SYNC_SECRET` 已更新 |
| 数据状态 | — | 509 records，448 有效价格（88%），61 price=null |

---

## 15. 2026-06-09 今日变更记录

| 变更 | 负责方 | 内容 |
|------|--------|------|
| Spray 2D 数据核查 | Codex | `C:\D3\data\records.json` 已有 Spray Gadget 27 个 item 的 2D variants；问题集中在上传前 tier/model 标准化与 Pantry 同步 |
| A 系列混卖归类规则 | Codex | variant 网络制式优先，避免 `4G/LTE` variant 被 `our_product` 误归到 5G 型号 |
| Tier 标准化 | Codex | cloud retry uploader 上传前补齐 `A/B/C`、`Offer→Promo`、`Offer(Gift Set)→Promo(Gift Set)` |
| Urban Republic tier | Codex | UR 无 Set 档位；上传 D1 前空 tier 改为 RAM+容量/容量（如 `12GB+256GB` / `256GB`），取不到才用 `Basic`，避免 D1 `(shop,item,model,tier)` 唯一键覆盖容量 |
| Shop Voucher 抓取 | Codex | Hermes CDP/browser 抓取商品页时读取 DOM voucher 区块，record 写入 `voucherAmount`（最大 `RM X off`，无券为 0），供 Worker/D1/前端后续计算到手价 |

---

## 17. 2026-06-12 Codex 变更记录（Dashboard 自家店覆盖 / Boss Table）

### Git 状态

| Commit | 内容 | 状态 |
|--------|------|------|
| `8a6dbc5` | `Fix dashboard self coverage and tier rendering` | 已 commit + push 到 GitHub `main` |
| `02c26dd` | `Restore boss table tier display` | 已 commit + push 到 GitHub `main` |

当前本地 `git status`：clean。

### `8a6dbc5` 包含的主要修复

| 范围 | 内容 |
|------|------|
| Master model code | 新增 / 修正 `F766 = Z Flip 7`，用于 Z Flip 7 256GB / 512GB exact SKU mapping |
| Self link rendering | Dashboard 读取 self row 时保留 `variantName`，避免只看 `name` 导致 tier / SKU 来源丢失 |
| Tablet LTE 显示 | `normalizeModelKey()` 改为：手机可把 LTE 显示成 4G；`Tab ... LTE` 不再强制变 `4G`，tablet 保留 WiFi / LTE / 5G |
| Boss table tier fallback | 当 `v.tier` 为空时，可从 `variantName` / `name` 解析 tier 信息，避免 self rows 被 `if (!ct) continue` 丢掉 |
| Audit exact matching | 手机默认 5G 系列允许 `A26 5G 256GB` 与 `A26 256GB` 视为同一 exact SKU；tablet 仍必须区分 WiFi / LTE / 5G |

### `02c26dd` 恢复 Boss Table 显示规则

用户确认：`A / B / C` 是 SKU 变体标识，不是价格层级，不应在 Boss Table 渲染成独立行。

当前规则：

| 输入来源 | 内部处理 | Boss Table 显示 |
|----------|----------|-----------------|
| `A / ...` | 参与价格计算，归到 `Standard` | 不显示 `A` 行 |
| `B / ...` | 参与价格计算，归到 `Standard` | 不显示 `B` 行 |
| `C / ...` | 参与价格计算，归到 `Standard` | 不显示 `C` 行 |
| `Basic` | 参与价格计算 | 显示 `Basic` |
| `Promo` | 参与价格计算 | 显示 `Promo` |
| `SET A` | 参与价格计算 | 显示 `SET A` |
| `Standard` | 参与价格计算 | 显示 `Standard` |

Boss Table 当前可渲染 tier 顺序：

```js
['Basic', 'Promo', 'SET A', 'Standard']
```

注意：不要把 `A / B / C` 改回 `null` 或直接丢弃，否则 Tab A11 这类 self rows 会再次因为 `if (!ct) continue` 从 Boss Table 计算中消失。正确做法是“内部参与计算，前端不显示 A/B/C 行”。

### 部署状态

`02c26dd` 已 push 到 GitHub。Codex 第一次在仓库根目录执行 `npx vercel deploy --prod --yes` 失败，原因是 Vercel CLI 在 `/mnt/c/D3` 根目录推断 project name 失败。正确部署目录应为：

```bash
cd /mnt/c/D3/d3-price
npx vercel deploy --prod --yes
```

Claude / Codex 接手时请先确认 production 是否已经部署到包含 `02c26dd` 的版本。

---

## 更新规范

每次有重大决定或架构变化，**由做出该决定的 AI 更新此文件并注明日期**。
