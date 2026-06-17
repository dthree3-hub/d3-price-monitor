# Handoff — Product Intake (Phase 1) + 待办 Merchant 管理

交接给下一个 Claude。日期 2026-06-17。分支 `telegram-ai-chat-mode`。

## 硬约束(沿用本任务)
- **不要 deploy、不要 push**(除非 Leon 明确要求)。
- 只动 Product Intake 相关:`d3-price/index.html`(浮层在文件末尾 `</body>` 前的自包含块)、`src/intake-products.mjs`、`scripts/test-intake-products.mjs`。
- **不要碰**现有 Dashboard 主代码、variant parser、D1、Hermes sweep。Phase 1 全程 localStorage,不接 D1/sweep。
- 改完跑 `node --check`(抽 IIFE)+ `node --test scripts/test-intake-products.mjs`。

## 已完成(已 commit,未 push)
- `e9031c0` Product Intake 页面 Phase 1(localStorage)。入口:登录后右下角 `🛠 Product Intake` 浮层。
- `40b6a1a` UI 修复:按钮深色文字(Edit/Ignore/Delete)、z-index→100002、Merchant 兜底初版、Delete 二次确认。
- `93341cf` Merchant dropdown 硬兜底:`DEFAULT_MERCHANTS` 常量、无 active 商家时重种(修 stale localStorage)、终极兜底不依赖 localStorage、**页面加载即填充**(不等点开浮层)。

### 数据结构(localStorage)
- `d3_product_intake`:`{id,shopee_url,item_id,shop_id,merchant_name,model_name,ram,storage,category,status,notes,review_needed,created_at,updated_at,last_checked_at,last_scrape_status,last_error}`
- `d3_merchant_registry`:`{id,merchant_name,merchant_type(our_store/competitor),platform,status,created_at,updated_at}` —— **待加 `is_default`**(见下)。
- 默认商家 `DEFAULT_MERCHANTS`:D3(our_store)/Deal Direct/TAC/Spray。

### Hermes 接口(inert,未接 sweep)
`src/intake-products.mjs loadIntakeProducts()` 读导出的 `product-intake.csv`(与 config/products.csv 同表头),返回 loadProducts 形状行。页面「Export Active」按钮导出该 CSV。Phase 2 接入=`[...loadProducts(), ...loadIntakeProducts()]`(文件底部有示例)。已验证导出→读回闭环。

## 本地运行(给 Leon 测试)
```
cd d3-price && python3 -m http.server 8080   # 后台 server 当前可能还在跑
```
正式页有密码门(crypto.subtle,file:// 或非 localStorage 的 http 下不可用)→ 用免密码副本测:
```
node -e 'const fs=require("fs");let h=fs.readFileSync("index.html","utf8");h=h.replace("if(sessionStorage.getItem(K)===\x271\x27){reveal();return;}","reveal();return;");fs.writeFileSync("intake-test-v3.html",h)'
```
开 `http://localhost:8080/intake-test-v3.html`(换新文件名可避开浏览器缓存)。WSL→Windows 若 localhost 不通,用 `http://<hostname -I 的 IP>:8080/...`。
⚠️ 临时文件 `d3-price/intake-test*.html` 是未跟踪的测试副本,**别 commit**;可删。

## 待办:Merchant 管理功能(Leon 要的,已设计好,直接实现)
**现状根因**:只有 `addMerchant`,**没有 deleteMerchant** → 新增的商家(如 NNNNN)删不掉。

### 需求
1. Merchant 下拉旁加 `[Manage Merchants]` 按钮,点开显示商家列表,每行右侧 `[Edit] [Delete]`。
2. **Delete 规则**:
   - 默认商家(D3/Deal Direct/TAC/Spray)不可删 → 行内不显示 Delete,或点了提示「默认商家不可删除」。
   - 自建商家可删,删前 `confirm('Delete merchant <name>?')`,确认后从 `d3_merchant_registry` 删 + `fillMerchantSelect()` 刷新下拉 + 重渲列表。
   - **若该商家被任何 product_intake 商品使用 → 不删**,提示:`This merchant is used by existing products. Please delete or change those products first.`
   - 没商品用 → 可删。
3. **加字段 `is_default`**:默认商家 `is_default:true`,自建 `is_default:false`。只有 `is_default===false` 可删/改。
4. Edit = 改名(自建商家),改名要级联更新用该商家的 product_intake 商品的 `merchant_name`,并刷新下拉/列表。

### 实现落点(index.html 末尾浮层 IIFE 内)
- `seedMerchants()`:默认商家加 `is_default:true`(已有 DEFAULT_MERCHANTS,line ~3293)。
- `addMerchant()`(line ~3416):push 时加 `is_default:false`;若管理面板开着则 `renderMerchantList()`。
- 新增 `var DEFAULT_NAMES`(小写名 set)+ `isDefault(m){return m.is_default===true || DEFAULT_NAMES[name.toLowerCase()];}`(兼容旧数据无 is_default 的默认商家按名判定)。
- 新增 `renderMerchantList()`:遍历 `merchants()`,默认行显示 `default` 标签,自建行显示 `[Edit][Delete]`(用 `.pi-rowbtn`)。
- 新增 `deleteMerchant(id)`:isDefault→拦;`products().some(p=>p.merchant_name===m.merchant_name)`→拦并提示;否则 confirm→`save` 过滤删→`fillMerchantSelect`+`renderMerchantList`。
- 新增 `editMerchant(id)`:isDefault→拦;prompt 新名→查重→级联改 product_intake 的 merchant_name→save 两个 key→刷新下拉/列表/商品列表。
- HTML:merchant-row(line ~3231)加 `<button id="pi-manage-merchant" class="pi-mini">Manage</button>`;在 Merchant `<label>` **之后**加 `<div id="pi-merchant-manage" class="pi-col2 pi-mmanage" hidden><div id="pi-merchant-list"></div></div>`(别放进 `<label>` 内,label 会劫持点击)。
- CSS:加 `.pi-mmanage`/`.pi-mrow`(flex space-between)/`.pi-mtag`。
- `init()`(line ~3445):wire `pi-manage-merchant` click → toggle `pi-merchant-manage` + `renderMerchantList()`。

### 验收
- 默认 4 家不可删(无 Delete 或被拦);NNNNN 可删且 confirm 后 localStorage + 下拉都没了;被商品占用的商家删不掉并提示;改名级联到商品。
- `node --check` + `node --test scripts/test-intake-products.mjs` 通过;只改 `d3-price/index.html`;不 deploy/push。

## git
分支 `telegram-ai-chat-mode`,本地 ahead origin(Product Intake 系列 commit 均未 push)。最新 `93341cf`。
