// 部署前准备：
// 1) 从 config/products.csv 生成 itemId -> 干净型号名 映射，注入 d3-price/index.html
// 2) 把最新 data/records.json 同步进 d3-price/data/records.json
// 用法：node src/build-itemmap.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const csvPath = path.join(root, 'config', 'products.csv');
const htmlPath = path.join(root, 'd3-price', 'index.html');
const recSrc = path.join(root, 'data', 'records.json');
const recDst = path.join(root, 'd3-price', 'data', 'records.json');

function parseCsv(text) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

// 去掉 "Samsung Galaxy " / "Samsung " 前缀，留下干净型号名
const cleanModel = (s) =>
  String(s).replace(/^\s*samsung\s+galaxy\s+/i, '').replace(/^\s*samsung\s+/i, '').trim();

const rawCsv = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(rawCsv);
const header = rows[0].map((cell) => cell.trim());
const map = {};
const watchlist = [];
for (const row of rows.slice(1)) {
  if (!row.some((cell) => String(cell || '').trim())) continue;
  const entry = Object.fromEntries(header.map((key, index) => [key, String(row[index] || '').trim()]));
  const productUrl = entry.product_url || '';
  const match = productUrl.match(/i\.(\d+)\.(\d+)/) || productUrl.match(/product\/(\d+)\/(\d+)/);
  if (!match) continue;
  const shopId = match[1];
  const itemId = match[2];
  if (entry.our_product) map[itemId] = cleanModel(entry.our_product);
  watchlist.push({
    shopId,
    itemId,
    competitor: entry.competitor || '',
    ourProduct: entry.our_product || '',
    productUrl,
  });
}

// 注入 index.html（替换 ITEMMAP 标记之间的内容）
let html = fs.readFileSync(htmlPath, 'utf8');
const block = `/*ITEMMAP_START*/window.D3_ITEM_MODEL = ${JSON.stringify(map)};window.D3_WATCHLIST = ${JSON.stringify(watchlist)};/*ITEMMAP_END*/`;
const re = /\/\*ITEMMAP_START\*\/[\s\S]*?\/\*ITEMMAP_END\*\//;
if (!re.test(html)) {
  console.error('找不到 ITEMMAP 标记，请确认 index.html 里有 /*ITEMMAP_START*/.../*ITEMMAP_END*/');
  process.exit(1);
}
html = html.replace(re, block);
fs.writeFileSync(htmlPath, html);

// 同步最新数据进部署目录
fs.mkdirSync(path.dirname(recDst), { recursive: true });
fs.copyFileSync(recSrc, recDst);
const recCount = JSON.parse(fs.readFileSync(recDst, 'utf8')).length;

console.log(`已注入型号映射 ${Object.keys(map).length} 条；已同步 records.json（${recCount} 条）到部署目录。`);
