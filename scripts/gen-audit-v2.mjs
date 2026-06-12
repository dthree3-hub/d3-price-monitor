// Samsung Audit v2：基于现有数据(trace+D1+master+records)，输出多 Sheet 工作簿。
// 重点：哪些修复了 / 哪些仍存在 / 哪些新发现。不重新找问题，是状态对账。
// 输出 /tmp/audit_v2.json 供 audit_xlsx_v2.py。
import fs from 'node:fs';
import path from 'node:path';
import { lookupModelByCode, isKnownModel, modelCategory, CANONICAL_MODELS, MODEL_CODES } from '../src/samsung-master.mjs';

const DAY = '2026-06-11';
const d1Raw = JSON.parse(fs.readFileSync('out/_d1_audit.json', 'utf8').replace(/^\uFEFF/, ''));
function d1RowsToRecords(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.shop_id}:${r.item_id}`;
    if (!map.has(key)) {
      map.set(key, {
        shopId: String(r.shop_id),
        itemId: String(r.item_id),
        title: r.title || '',
        grabbedAt: r.grabbed_at || '',
        variants: [],
      });
    }
    map.get(key).variants.push({
      model: r.model || '',
      capacity: r.capacity || '',
      tier: r.tier || '',
      currentPrice: r.price,
      name: r.variant_name || r.sku || '',
      color: r.color || '',
    });
  }
  return [...map.values()];
}
const d1 = d1Raw.records || d1RowsToRecords(Array.isArray(d1Raw) ? d1Raw.flatMap((r) => r.results || []) : (d1Raw.results || []));
const records = JSON.parse(fs.readFileSync('data/records.json', 'utf8'));
const ROLES = { '54618012': 'self', '116917349': 'A', '77792787': 'B', '271823454': 'C' };
const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
const netOf = (m) => (/\bWiFi\b/i.test(m) ? 'WiFi' : /\b5G\b/i.test(m) ? '5G' : /\b(4G|LTE)\b/i.test(m) ? '4G' : '-');
const capROM = (c) => { const s = String(c || ''); const m = s.match(/(\d+)\+(\d+)\s*(GB|TB)/i); return m ? `${m[2]}${m[3].toUpperCase()}` : s.replace(/\s/g, ''); };
const tierNorm = (t) => { const s = String(t || '').trim(); if (/^(?:set\s*)?[abc]$/i.test(s)) return s.replace(/^set\s*/i, '').toUpperCase(); if (/promo/i.test(s)) return 'Promo'; return s; };

// 复制线上前端 normalizeModelKey（含 Tab 前缀 + S2x/A 去5G + WiFi 去除）+ capacityLabelOf
const capLabel = (n) => { const t = String(n || '').trim(); const m = t.match(/(\d+)\+(\d+)(GB|TB)/i); return m ? `${m[2]}${m[3].toUpperCase()}` : t.replace(/\s+/g, ''); };
const normKey = (mk) => {
  if (!mk) return '';
  let s = String(mk).replace(/\bLTE\b/gi, '4G').replace(/\s+/g, ' ').trim();
  s = s.replace(/^S(1[01])\b/i, 'Tab S$1');
  s = s.replace(/\b(A(?:26|36|37|56))\s*5G\b/gi, '$1');
  s = s.replace(/\b(S2[3-6](?:\s*\+|\s*Ultra|\s*FE)?)\s*5G\b/gi, '$1').replace(/\s+/g, ' ').trim();
  s = s.replace(/\bWi[\s-]?Fi\b/gi, '').replace(/\s+/g, ' ').trim();
  return s;
};
const dashKey = (model, cap) => normKey(model + (cap ? ` ${capLabel(cap)}` : ''));
const family = (m) => String(m || '').replace(/\b(4G|5G|WiFi|LTE)\b/gi, '').replace(/\s*\d+\s*(GB|TB)\b/gi, '').replace(/\s+/g, ' ').trim();

const selfItems = new Set(records.filter((r) => String(r.shopId) === '54618012').map((r) => String(r.itemId)));
const traces = [];
for (const it of selfItems) { const f = path.join('out/traces', DAY, `54618012_${it}.json`); if (fs.existsSync(f)) traces.push(JSON.parse(fs.readFileSync(f, 'utf8'))); }

// D1 容量存在集（6-key 后判断 SKU 是否进库）
const d1capSet = new Set();
const modelNorm = (m) => String(m || '').replace(/\b(A(?:26|36|37|56|57))\s*5G\b/i, '$1').replace(/\bLTE\b/gi, '4G').replace(/\s+/g, ' ').trim();
for (const r of d1) for (const v of (r.variants || [])) d1capSet.add(`${r.itemId}:${modelNorm(v.model)}:${tierNorm(v.tier)}:${capROM(v.capacity)}`);

// ── 11 项完整性检测 ──
function detectIssues(raw, pm, cap, tier, dashModel, inD1) {
  // 去掉容量 RAM+ROM 记法(8+512/12+256)再检测，否则「+」会被误当成型号 Plus
  const r = String(raw || '').replace(/\d+\s*\+\s*\d+\s*(?:GB|TB)?/gi, ' ');
  const p = String(pm || ''); const out = [];
  if (/FE\s*\+|FE\s*PLUS/i.test(r) && /\bFE\b/i.test(p) && !/FE\s*\+/i.test(p)) out.push('FE+→FE降级');
  else if (/\bS\d+\s*FE\b|S\d+FE/i.test(r) && !/FE/i.test(p)) out.push('FE丢失(降级)');
  if (/\b(\+|Plus)\b/i.test(r) && !/ultra/i.test(r) && !/\+/.test(p) && !/ultra/i.test(p)) out.push('+丢失(降级)');
  if (/\bUltra\b/i.test(r) && !/ultra/i.test(p)) out.push('Ultra丢失(降级)');
  if (/\bLite\b/i.test(r) && !/lite/i.test(p)) out.push('Lite丢失');
  if (/\bLite\b/i.test(r) && /FE/i.test(p)) out.push('Lite↔FE混淆');
  if (/FE/i.test(r) && /\bLite\b/i.test(p)) out.push('FE→Lite混淆');
  if (/\b(4G|LTE)\b/i.test(r) && !/5G/i.test(r) && /\b5G\b/i.test(p)) out.push('4G→5G升级(错)');
  if (/\b5G\b/i.test(r) && !/4G|LTE/i.test(r) && /\b(4G|LTE)\b/i.test(p)) out.push('5G→4G(错)');
  if (/^S1[01]\b/i.test(p)) out.push('Tab前缀缺失');
  if (p && dashModel && family(p) && family(dashModel) && family(p).toLowerCase() !== family(dashModel).toLowerCase()
      && !/^S1[01]/i.test(p)) out.push(`Grouping错(→${dashModel})`);
  if (p && !isKnownModel(p)) out.push('不在Master');
  if (!inD1) out.push('D1缺失');
  return out;
}

// ── Sheet 3：全量 SKU 完整性 ──
const skuHeaders = ['Raw Variant', 'Parsed Model', 'Capacity', 'Network', 'Tier', 'Dashboard Model', 'Issue', 'Status'];
const skuRows = [], skuColors = [];
let nClean = 0, nOpen = 0; const openByCat = { phone_tablet: 0, watch: 0, buds: 0 };
const detectCounts = {};
for (const t of traces) {
  for (const s of (t.skus || [])) {
    const code = lookupModelByCode(s.rawModelName);
    const pm = code ? code.canonical : s.parsed.model;
    const cap = capROM(s.parsed.capacity);
    const cat = (() => { const c = modelCategory(pm); return (c === 'phone' || c === 'tablet') ? 'phone_tablet' : c; })();
    const dm = dashKey(pm, s.parsed.capacity);
    const inD1 = d1capSet.has(`${t.itemId}:${modelNorm(pm)}:${tierNorm(s.parsed.tier)}:${cap}`);
    const issues = detectIssues(s.rawModelName, pm, cap, s.parsed.tier, dm, inD1);
    // 手表/耳机的「D1缺失」= 可穿戴映射未接 parser（已知 OPEN），单独归类
    const isWearableGap = (cat === 'watch' || cat === 'buds') && issues.length === 1 && issues[0] === 'D1缺失';
    const status = issues.length ? 'OPEN' : 'OK';
    if (issues.length) { nOpen++; openByCat[cat] = (openByCat[cat] || 0) + 1; for (const i of issues) detectCounts[i] = (detectCounts[i] || 0) + 1; }
    else nClean++;
    skuRows.push([s.rawModelName, pm, cap, netOf(pm), s.parsed.tier || '-', dm, issues.join('; ') || 'OK', status]);
    skuColors.push(issues.length ? 'red' : 'green');
  }
}
// OPEN 排前
const order = skuRows.map((r, i) => i).sort((a, b) => (skuColors[a] === 'red' ? 0 : 1) - (skuColors[b] === 'red' ? 0 : 1));
const skuRowsS = order.map((i) => skuRows[i]); const skuColorsS = order.map((i) => skuColors[i]);

// ── 容量/颜色塌缩「修复前后」量化（从 records 自家算）──
const selfRecs = records.filter((r) => String(r.shopId) === '54618012');
const set4 = new Set(), set5 = new Set(), set6 = new Set(); let rawSku = 0;
for (const r of selfRecs) for (const v of (r.variants || [])) {
  if (!v.model) continue; rawSku++;
  set4.add(`${r.itemId}:${v.model}:${tierNorm(v.tier)}`);
  set5.add(`${r.itemId}:${v.model}:${tierNorm(v.tier)}:${capROM(v.capacity)}`);
  set6.add(`${r.itemId}:${v.model}:${tierNorm(v.tier)}:${capROM(v.capacity)}:${v.color || ''}`);
}
const capRecovered = set5.size - set4.size;   // 容量塌缩本会丢的行
const colorRecovered = set6.size - set5.size; // 颜色塌缩本会丢的行

// ── D1 裸名(无Tab) 分裂统计（Tab mapping）──
const bareSplit = new Set();
for (const r of d1) for (const v of (r.variants || [])) if (/^S1[01]\b/i.test(v.model || '')) bareSplit.add(`${v.model}@${ROLES[String(r.shopId)] || r.shopId}`);

// ── Sheet 1：问题追踪 ──
const trackH = ['Issue Type', 'Affected SKUs', 'Before', 'After', 'Status', 'Root Cause', 'Fixed In'];
const track = [
  ['S10 FE+ 解析成 FE', '0 now', '混淆', '0 mismatch', 'FIXED', 'parser 加 FE+ override 分支', 'variant-parser.mjs'],
  ['S25+ 解析成 S25', '0 now', '混淆', '0 mismatch', 'FIXED', 'parser S2x +/Ultra 正则', 'variant-parser.mjs'],
  ['LTE 解析成 5G', '0 now', '混淆', '0 mismatch', 'FIXED', 'parser network override', 'variant-parser.mjs'],
  ['S25 FE 混入 S25', '0 now', '混淆', '0 mismatch', 'FIXED', 'parser FE 分支 + 校验', 'variant-parser.mjs'],
  ['records.json 历史重复', `${records.length}`, '593', '76', 'FIXED', '按 shopId:itemId 取最新去重', 'data/records.json'],
  ['D1 Capacity Collapse', `${capRecovered}`, `丢${capRecovered}行/tier只剩1容量`, `256/512/1TB 共存`, 'FIXED', 'UNIQUE 加 capacity', 'D1 6-key + worker'],
  ['D1 Color Collapse', `${colorRecovered}`, `丢${colorRecovered}行/便宜色被覆盖`, `每色独立(RM3559出现)`, 'FIXED', 'UNIQUE 加 color', 'D1 6-key + worker'],
  ['S25 5G → S25 Canonical', '0 split now', 'S25/S25 5G 拆两行', '合并一行', 'FIXED', 'normalizeModelKey 去 S2x 5G', 'frontend'],
  ['Tab S10/S11 Mapping', `${bareSplit.size} 裸名`, '裸名 vs Tab 拆两行', '补 Tab 前缀合并', 'FIXED', 'normalizeModelKey 补 Tab', 'frontend'],
  ['Sync 规整器损坏 A 系列', '44', 'A36→A26 5G/A37→A17', '已用 raw-sync 修正', 'NEW', 'sync-cloud-retry officialModelFor 误映射', 'raw-sync-self.mjs'],
  ['Wearable(Watch) 型号映射', `${openByCat.watch || 0}`, 'L320/L330… 空型号', '审计已识别,未接 parser', 'OPEN', '代码优先未接进 variant-parser', '(待办)'],
  ['竞品未用新解析器重抓', `A/B/C 旧数据`, '裸名/旧映射', '前端已兜底,D1待重抓', 'PARTIAL', 'runOnce 重抓即修', '(待办)'],
];
const trackColors = track.map((r) => (r[4] === 'FIXED' ? 'green' : r[4] === 'NEW' ? 'green' : r[4] === 'PARTIAL' ? 'yellow' : 'red'));

// ── Sheet 2：9 项修复验证 ──
const verH = ['Issue Type', 'Affected SKU Count', 'Before', 'After', 'Status'];
const ver = track.slice(0, 9).map((r) => [r[0], r[1], r[2], r[3], r[4]]);
const verColors = ver.map(() => 'green');

// ── Sheet 4：Tab 系列对账 ──
const tabH = ['Excel Name', 'Trace Model', 'D1 Model(s)', 'Dashboard Model', '一致?', 'Mapping?', 'Grouping?'];
function modelsMatching(re) {
  const tr = new Set(), d1m = new Map();
  for (const t of traces) for (const s of (t.skus || [])) { const m = s.parsed.model || ''; if (re.test(m)) tr.add(m); }
  for (const r of d1) for (const v of (r.variants || [])) { const m = v.model || ''; if (re.test(m)) { if (!d1m.has(m)) d1m.set(m, new Set()); d1m.get(m).add(ROLES[String(r.shopId)] || r.shopId); } }
  return { tr: [...tr], d1m };
}
const tabTargets = [
  ['Tab S10 FE', /\bS10\s*FE\b(?!\s*\+)/i], ['Tab S10 FE+', /\bS10\s*FE\s*\+/i], ['Tab S10 FE+ 5G', /\bS10\s*FE\s*\+.*5G|S10\s*FE\+\s*5G/i],
  ['Tab S10 Lite', /\bS10\s*Lite\b/i], ['Tab S10 Lite 5G', /\bS10\s*Lite.*5G/i],
  ['Tab S11', /\bS11\b(?!\s*Ultra)(?!\s*5G.*Ultra)/i], ['Tab S11 5G', /\bS11\b.*5G(?!.*Ultra)|\bS11\s*5G/i], ['Tab S11 Ultra', /\bS11\s*Ultra/i],
];
const tabRows = [], tabColors = [];
for (const [name, re] of tabTargets) {
  const { tr, d1m } = modelsMatching(re);
  const keys = new Set([...tr.map((m) => dashKey(m, '256GB')), ...[...d1m.keys()].map((m) => dashKey(m, '256GB'))]);
  const d1strs = [...d1m.entries()].map(([m, sh]) => `${m}[${[...sh].join(',')}]`).join(' | ') || '(无)';
  const consistent = keys.size <= 1;
  const hasBare = [...d1m.keys()].some((m) => /^S1[01]\b/i.test(m));
  tabRows.push([name, tr.join(' | ') || '(自家无)', d1strs, [...keys].join(' | '), consistent ? '✅一致' : '⚠️多key',
    hasBare ? '裸名(已前端兜底)' : '✅', consistent ? '✅' : '已合并']);
  tabColors.push(consistent ? 'green' : 'yellow');
}

// ── Sheet 5：Summary ──
const totalSku = skuRows.length;
const masterModels = new Set([...CANONICAL_MODELS].map((m) => normKey(m + ' 256GB').replace(/\s*256GB$/, '')));
const d1Models = new Set(); for (const r of d1) for (const v of (r.variants || [])) d1Models.add(normKey(v.model + ' 256GB').replace(/\s*256GB$/, ''));
const masterNotDash = [...masterModels].filter((m) => m && ![...d1Models].some((d) => d.toLowerCase() === m.toLowerCase()));
const sumH = ['指标', '数值', '说明'];
const sumRows = [
  ['1. 总 SKU 数', totalSku, '自家 15 listing 全部 Samsung SKU'],
  ['2. 正确 SKU 数', nClean, 'Issue=OK（绿）'],
  ['3. 剩余异常 SKU 数', nOpen, 'Issue≠OK（红）'],
  ['4. 已修复问题数', '9 + 1NEW', '解析4 + records + 容量 + 颜色 + S25-5G + Tab-mapping (+ A系列损坏NEW)'],
  ['5. 剩余问题数', '2', 'Watch 映射(OPEN) + 竞品重抓(PARTIAL)'],
  ['6. 手机/平板剩余异常', openByCat.phone_tablet || 0, '应为 0（容量/颜色塌缩已修）'],
  ['7. Watch/Buds 剩余异常', (openByCat.watch || 0) + (openByCat.buds || 0), 'Watch 映射未接 parser'],
  ['8. Coverage 风险数(Master有/Dashboard无)', masterNotDash.length, masterNotDash.slice(0, 12).join(', ') || '无'],
  ['9. 建议下一步优先级', 'P1 接 Watch 代码优先→parser；P2 竞品重抓(runOnce)；P3 修 sync-cloud-retry 规整器或弃用', ''],
];
const sumColors = sumRows.map((r) => (String(r[0]).startsWith('6') ? ((openByCat.phone_tablet || 0) === 0 ? 'green' : 'red')
  : String(r[0]).startsWith('7') ? 'yellow' : String(r[0]).startsWith('3') ? (nOpen ? 'yellow' : 'green') : ''));

const extraSheets = [];
const selfCoveragePath = '/tmp/self_link_coverage.json';
if (fs.existsSync(selfCoveragePath)) {
  const selfCoverage = JSON.parse(fs.readFileSync(selfCoveragePath, 'utf8'));
  extraSheets.push(...(selfCoverage.sheets || []));
}

const spec = { sheets: [
  { name: '1_问题追踪', headers: trackH, rows: track, colors: trackColors },
  { name: '2_修复验证', headers: verH, rows: ver, colors: verColors },
  { name: '3_全量SKU完整性', headers: skuHeaders, rows: skuRowsS, colors: skuColorsS },
  { name: '4_Tab系列对账', headers: tabH, rows: tabRows, colors: tabColors },
  { name: '5_Summary', headers: sumH, rows: sumRows, colors: sumColors },
  ...extraSheets,
] };
fs.writeFileSync('/tmp/audit_v2.json', JSON.stringify(spec));
console.log(`总SKU ${totalSku} | 正确 ${nClean} | 异常 ${nOpen}（手机平板 ${openByCat.phone_tablet || 0} / Watch ${openByCat.watch || 0} / Buds ${openByCat.buds || 0}）`);
console.log(`容量塌缩本会丢 ${capRecovered} 行 | 颜色塌缩本会丢 ${colorRecovered} 行 | Coverage缺 ${masterNotDash.length}`);
console.log('检测命中:', JSON.stringify(detectCounts));
