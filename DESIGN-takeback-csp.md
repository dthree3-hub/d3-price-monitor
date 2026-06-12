# 设计手册：Take Back ← Google Sheets 接入（给 Claude 2 实施用）

> 状态：**仅设计，未写代码、未 commit 代码、未 deploy**。Leon 已确认走 Worker `/api/csp` 方案。
> 目标：**Google Sheets 改 CSP / Take Back → Dashboard 不用 deploy 就能看到最新值**。

---

## 0. 不要重做的部分（已存在，复用）
- `src/google-sheets.mjs` —— 只读 Sheets 客户端（服务账号 JWT，scope readonly）。**只读，无写入函数**。
- `src/csp-source.mjs` —— 读 `Samsung!A:B`(A=型号 B=CSP)、6h 缓存 `out/csp-cache.json`、失败回退。
- `d3-price/index.html` —— Take Back **栏位 + 样式 + 算法已存在**（表头 `Take back` L2892、`.takeback-pos/neg/zero`、`tb = best.price − csp` L2937–2945）。
- **缺的只是**：Sheet 的 CSP/Take Back 数据没有接进 Dashboard。现在 `cspPrices` 从 localStorage 读且**无写入 UI** → Take Back 实际恒显示 `—`。

## 1. 关键事实
- **匹配 key**：Dashboard 用 `mk = normalizeModelKey(model + ' ' + capacity)`，如 `"A06 5G 128GB"`、`"S26+ 512GB"`。**按 型号+容量，不分颜色、不分 tier**，一个 mk 一行一个 Take Back 值。网络制式(4G/5G)已含在 model 内。
- **Sheet**：`https://docs.google.com/spreadsheets/d/1CWnB3Nzpo7_Svw7zzJnOulDIuJwUlW7_DmZLtXoPITY/` ，tab gid `1104856439`。ID = `1CWnB3Nzpo7_Svw7zzJnOulDIuJwUlW7_DmZLtXoPITY`。
- **`.env` 现状**：`GOOGLE_SHEET_ID` / `GOOGLE_SERVICE_ACCOUNT_JSON` 都空；从无 `csp-cache.json` → **系统从未真正连过 Sheet**。

## 2. ⚠️ 运行时陷阱（必读）
Worker 跑在 **Cloudflare Workers，不是 Node**。`google-sheets.mjs` 用了 `node:crypto`+`node:fs`，**在 Worker 里跑不了**。所以 `/api/csp` 里 JWT 签名要用 **WebCrypto (`crypto.subtle`, RSASSA-PKCS1-v1_5 + SHA-256)** 重写那 ~30–40 行；service account JSON 存成 **Worker secret**（不能读文件）。`csp-source.mjs` 的「读区间→解析列→建映射」思路照搬即可。**这不是重做 Take Back，是换运行时的鉴权实现。**

## 3. 为什么是 Worker /api/csp（B 方案）
- A（build 注入）：每改 Sheet 都要重新 build + `vercel --prod` → ❌ 不满足「不 deploy 就看到」。
- C（前端输入/上传）：SoT 变成浏览器 → ❌ Sheet 不再是 source of truth。
- **B（Worker 动态读 Sheet）→ ✅ 唯一满足。**

## 4. 数据流
```
Google Sheet (SoT, 人手改)
 └ Worker GET /api/csp ── WebCrypto JWT→token→Sheets API 读 sku_key/take_back
      └ 缓存 ~30–60s（防每个访客每30s都打 Google）
         └ 返回 { ok, updatedAt, rows:{ [sku_key]:{ take_back, csp } }, error? }
            └ Dashboard: 启动 + 每30s + Refresh 按钮 fetch
               └ Take Back 单元格直接显示 Sheet 值（不硬算）；缺/空 → —
```

## 5. Sheet 列 schema（推荐）
以 **`sku_key` 为权威匹配列**（不要让代码拼 model+capacity，避免和 `normalizeModelKey` 漂移）：

| sku_key (= dashboard mk) | take_back (RM, 要显示的最终值) | csp (可选参考) | model / capacity (可选, 人看, 代码忽略) |
|---|---|---|---|
| `A06 5G 128GB` | `549` | `470` | A06 5G / 128GB |
| `S26 Ultra 256GB` | (空 → 显示 —) | … | … |

- 第一行表头，代码跳过；匹配时两边都过 `normalizeModelKey` 容错。

## 6. 需要改的文件（4 处 + Sheet）
1. **`d3-worker/src/index.js`** — 新增 `GET /api/csp`：WebCrypto 签 JWT → token → 读 Sheet → 解析 `{sku_key:{take_back,csp}}` → 缓存 → 返回 JSON（含 `updatedAt`/`error`），带 CORS。
2. **`d3-worker/wrangler.toml` + secret** — `GOOGLE_SHEET_ID`、`GOOGLE_CSP_TAB`、`GOOGLE_CSP_RANGE` 变量；`wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`。缓存可用 `caches.default`（免绑定）或 KV。
3. **`d3-price/index.html`** — `fetchCsp()`：启动 + `setInterval 30s` + 挂到现有 `#bossRefreshNow`；存 `takeBackByKey`（内存+localStorage 兜底）；Take Back 单元格改成读 `takeBackByKey[normalizeModelKey(mk)]` **直接显示**（删 `best.price − csp` 硬算）；加 Sheet error/陈旧提示。
4. **`src/csp-source.mjs` / `google-sheets.mjs`** — B 方案下基本不动，保留作 Node 侧调试。
5. **Google Sheet 本身** — 按 schema 排 `sku_key`/`take_back`(/`csp`) + 表头；把 service account 邮箱共享为 **Viewer**。

## 7. 失败/边界处理（Leon 要求）
| 情况 | 行为 |
|---|---|
| Sheet 没有该 SKU | 该行 Take Back → `—` |
| Sheet 有该 SKU 但值空 | → `—` |
| `/api/csp` 请求失败 | 前端**保留上一次成功值**；从无成功值则显示 `Sheet error` |
| Worker 读 Sheet 失败 | 返回 `{ok:false,error}` + Worker 侧最近成功快照；前端据此显示旧值或 error |
| 防刷 Google | Worker 缓存 30–60s，N 个访客每 30s 拉，Google 实际 ≤1 次/窗口 |

## 8. 硬约束（Leon）
- **不要写 Google Sheets，只读**；Sheet 是 source of truth。
- **Dashboard 不硬算最终 Take Back**，直接显示 Sheet 值。

## 9. 待 Leon 拍板（决定 schema/语义，开工前确认）
1. **Take Back 值由谁定？** 推荐(符合「不硬算」)：**Sheet 直接给最终 `take_back` 数字**，Dashboard 原样显示。备选：Sheet 只给 `csp`，Dashboard 算 `最低对手价 − csp`（=硬算，与要求冲突）。
2. **tab(gid 1104856439) 的名字 + 现有列布局**？需要 tab 名 + 列顺序定 `GOOGLE_CSP_TAB`/`GOOGLE_CSP_RANGE`，并确认有没有现成 `sku_key` 列（没有就加一列，或用 model+capacity 帮拼）。
