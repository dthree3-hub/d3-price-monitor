# D3 书签安装与使用

## 安装

1. 打开 Chrome 收藏栏。
2. 新建一个收藏。
3. 名称填：`抓价`
4. 网址填 [dist/grab-price.bookmarklet.txt](/home/sarah/projects/D3/dist/grab-price.bookmarklet.txt:1) 里的整行 `javascript:...`

如果 `dist/grab-price.bookmarklet.txt` 还没生成，先运行：

```bash
cd /home/sarah/projects/D3
npm run build:bookmarklet
```

## 使用

1. Sarah 用自己的账号登录 `shopee.com.my`
2. 打开某个竞争对手手机商品页
3. 点收藏栏里的 `抓价`
4. 右上角弹框会显示：
   - 商品标题
   - shop id / item id
   - 每个 variant 的当前价
   - 原价差异
   - 缺货状态

## 弹框按钮说明

- `复制摘要`
  适合直接发给人看
- `复制 JSON`
  适合临时贴到控制台页导入
- `复制 CSV`
  适合单品快速贴进表格
- `下载 JSON`
  推荐。每个商品存一个结构化文件，后面批量导入控制台
- `下载 CSV`
  单商品一份 CSV

## 汇总

1. 打开 [dashboard/index.html](/home/sarah/projects/D3/dashboard/index.html:1)
2. 把多个 `d3-shopee-price-*.json` 拖进去
3. 检查表格
4. 点 `导出汇总 CSV`

## 常见问题

### 1. 提示“接口没有返回商品数据”

先刷新商品页再点一次。

如果还是不行，通常是：

- 页面还没完全加载完
- 当次会话被 Shopee 软拦截
- 当前页其实不是标准商品页

### 2. 为什么不用服务器自动抓

因为这条路已经实测不成立：

- Playwright 会被反爬挡
- VPS IP 更容易死
- ScraperAPI 成本不合理

### 3. 为什么控制台页不直接自动接收书签结果

书签运行在 `shopee.com.my` 页面上下文，浏览器本地页是另一套 origin，不能直接共享 `localStorage`。当前这版用 `下载 JSON -> 本地汇总`，是零成本且稳定的中间方案。

## 下一个合理升级

把书签里的导出动作改成：

- `POST` 到 Google Apps Script Web App
- 或 `POST` 到公司内部录入接口

这样就能从“下载 JSON 再导入”进化到“点一下直接入库”。
