# D3 Price Monitor — SSOT (Single Source of Truth)

> Claude 和 Codex 的共同参考文件。所有已决定的事不重复问，直接查这里。
> Last updated: 2026-06-09

---

## 给 Codex 的说明

每次开始任务前先读这份文件。它记录了分工边界、冻结区、当前项目状态、数据格式规范。
如果你的工作会影响数据格式、型号命名、价格规则，**先更新这份文件再动代码**。

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

## 更新规范

每次有重大决定或架构变化，**由做出该决定的 AI 更新此文件并注明日期**。
