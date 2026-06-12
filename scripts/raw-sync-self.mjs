// 原样把 records.json 推到云端 /api/sync —— 不经 sync-cloud-retry 的 sanitizeVariant
// （那个 officialModelFor 在混合 A 系列 listing 上会把 A36→A26 5G、A37→A17 误映射）。
// variant-parser 产出的 v.model 已经是对的，直接原样推。带 .env 的 X-D3-Secret。
import fs from 'node:fs';
import { loadEnvFile } from '../src/lib-hermes.mjs';

loadEnvFile();
const url = process.env.D3_CLOUD_RECORDS_URL || 'https://d3-price-worker.dthree.workers.dev/api/sync';
const secret = process.env.D3_CLOUD_SYNC_SECRET || '';
if (!secret) { console.error('缺 D3_CLOUD_SYNC_SECRET'); process.exit(1); }

const records = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const payload = { records }; // 原样，不动 model/capacity/tier/color

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-D3-Secret': secret },
  body: JSON.stringify(payload),
});
const text = await res.text();
console.log('HTTP', res.status, '|', text.slice(0, 200));
if (!res.ok) process.exit(1);
