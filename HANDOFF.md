# D3 价格监控 — 交接文档 (2026-06-05)

## 一句话现状
d3-price 看板已上线 https://d3-price.vercel.app ，型号分类(A方案)+ S系列归一化 + Urban Republic 修复都已完成并部署。**当前卡点:用户在 Telegram `/run` 后抓取数据没落地,Spray Gadget 27 款里 25 款还没数据。** 下一步要做「Watch/Tab/Buds 组合页的子型号拆分」。

## 两个看板(别搞混)
- `dashboard/app.js` → 桌面 `D3-dashboard.html`(旧的简单版,competitorBoard 风格)
- **`d3-price/index.html` → Vercel 部署(老板看的「完整对比表」,本次所有改动都在这里)**
  - Vercel 项目:`d3-price`(已 link,`d3-price/.vercel/project.json`)
  - 读 `/data/records.json`(部署目录 `d3-price/data/records.json`,由 build-itemmap 从根目录 `data/records.json` 同步)
  - 登录态:`npx vercel whoami` = sarahng929(已登录)

## 本次已完成
1. **删除** TAC Mobile(全部:products.csv / records.json / `d3-price/index.html` 里 KNOWN 映射的 271823454)、删除 S25 Demo Set、删除早期孤儿记录(空卖家的 S26+/S26U)。
2. **A 方案分类**(`d3-price/index.html` 的 `modelKeyOf`,约 2084 行):
   - 型号家族优先用 `products.csv` 的 `our_product` 人工标签,通过 `window.D3_ITEM_MODEL`(itemId→型号名)注入,调用点约 2171 行 `modelKeyOf(r.title, v.name, window.D3_ITEM_MODEL[itemId])`。
   - `normFamilyS()`:把 S25/S26/S27… + `Ultra`/`U`/`Plus`/`+`/`plus` 任意写法归一(`s26+`/`s26plus`/`S26 Plus` 全归 `S26+`);注意不会把容量里的 `12+512` 的 `+` 误判成 plus。
   - 容量**只从款式名抠,不读标题**(标题列了所有容量会乱);正则 `(\d+)(?:GB|TB)?\+(\d+)(GB|TB)?` 取第二个数=存储,兼容 `12+512` 和 Urban Republic 的 `12GB+256GB`。
   - `canonTier()`:gift set / demo → 丢弃;promo/basic/set a 照旧;**档位栏是容量(Urban Republic 无 Basic/Promo)→ 当 `标准`**。
3. **`src/build-itemmap.mjs`**(新增):读 products.csv 生成 itemId→型号名映射,注入 index.html 的 `/*ITEMMAP_START*/.../*ITEMMAP_END*/` 标记之间,并把根 `data/records.json` 同步到 `d3-price/data/records.json`。
4. **Spray Gadget 全量入库**:27 条链接已分类填入 products.csv(competitor=Spray Gadget),替换了旧的 2 条。
5. 多次部署完成,现状 products.csv:Our Store 1 / Urban Republic 1 / Deal Direct 18 / Spray Gadget 27。

## 部署流程(三步)
```
1. 改 config/products.csv
2. node src/build-itemmap.mjs
3. cd d3-price && npx vercel deploy --prod --yes
```

## 当前卡点(优先处理)
用户 Telegram 发 `/run`,bot 回了「我现在开始检查,请稍等」(= `src/telegram-bot.mjs:124`,这是真 `/run`,紧接着调 `runOnce()`)。但 `data/records.json` 没更新(仍 47 条,Spray Gadget 仅 2/27,最新 grabbedAt = `2026-06-05T06:39Z`=14:39,已近 2 小时无新数据)。
- bot 活着、Chrome 开着且虾皮登录态正常(用户已确认右上角是其账号)。
- **需要 bot 的第二条消息**:成功汇总 或 `这轮检查失败了:<原因>`(`telegram-bot.mjs:127/129`)。卡在这条还没拿到。
- 怀疑点:runOnce 卡在某款(可能某 CDP 抓取超时/某链接加载问题);注意新加的 Spray Gadget 链接在 products.csv 里是**截短的 slug**(去掉了 extraParams/sp_atk,只留 `i.shop.item`)——理论上能导航,但若 runOnce 在某款 hang 住会导致整轮不写文件。建议查 Windows 端 runOnce 日志/逐款超时。

## 待做(用户明确要求)
**Watch / Tab / Buds 组合页的子型号拆分**(S10 Ultra≠S10、S11 Ultra≠S11、Watch 8≠Watch Ultra、Buds 3≠Buds 3 Pro)。基于已抓到的 Deal Direct 数据,真实款式名格式如下:
- Buds:`Buds 4 Pro (Black)` / `Buds 4 (Black)` → 有「Pro」字样,**规则可拆**。
- Tab S11:`S11U 512GB` / `S11 256GB` → U 区分,**规则可拆**。
- Tab S10 FE:`FE+ (12+256)` / `FE (12+256)` → FE+/FE,**规则可拆**。
- **Watch:`L320 (40mm)` / `L330 (44mm)` / `L705N (47mm)` / `L500 (46mm)` → 款式名是内部代号,无 Watch 8/Ultra 字样,纯规则拆不了**,需代号表(推测 L320/L330=Watch 8、L500=Watch 8 Classic、L705N=Watch Ultra,**待用真实数据核对**)或 DeepSeek。
- ⚠️ 建议先让 Spray Gadget 抓取成功(它的款式名写法可能与 Deal Direct 不同),拿到真实款式名再写拆分规则,否则是猜。

## 其它
- **所有改动尚未 git commit**(删 TAC/Demo、A方案、build-itemmap、Spray Gadget 入库等),建议尽快提交存档。分支 main。
- 备份:`data/records.json.bak-*` 若干。
