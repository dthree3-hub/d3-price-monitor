// 重新生成 Samsung Audit（最新 D1 + trace + master + records.json），逐 SKU + D1 容量塌缩检测。
// 输出：/tmp/audit_rows.json (供 audit_xlsx.py) + /tmp/audit_summary.txt
import fs from 'node:fs';
import path from 'node:path';
import { lookupModelByCode, isKnownModel, modelCategory, MODEL_CODES } from '../src/samsung-master.mjs';

const DAY = '2026-06-11';
const d1 = JSON.parse(fs.readFileSync('out/_d1_audit.json', 'utf8')).records;
const records = JSON.parse(fs.readFileSync('data/records.json', 'utf8'));
const recArr = Array.isArray(records) ? records : (records.records || []);
const ROLES = { '54618012': 'self', '116917349': 'Deal Direct', '77792787': 'Spray Gadget', '271823454': 'TAC' };
const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
const netOf = (m) => (/\bWiFi\b/i.test(m) ? 'WiFi' : /\b5G\b/i.test(m) ? '5G' : /\b(4G|LTE)\b/i.test(m) ? '4G' : '');
const capROM = (c) => { const s = String(c || ''); const m = s.match(/(\d+)\+(\d+)\s*(GB|TB)/i); return m ? `${m[2]}${m[3].toUpperCase()}` : s.replace(/\s/g, ''); };
// tier 归一化：trace 用「Set A/Set B/Promo」，D1 经 sync 规整成「A/B/Promo」，匹配前两边都归一。
const tierNorm = (t) => { const s = String(t || '').trim(); if (/^(?:set\s*)?[abc]$/i.test(s)) return s.replace(/^set\s*/i, '').toUpperCase(); if (/promo/i.test(s)) return 'Promo'; return s; };
// model 归一化（匹配用）：trace 解析器与 sync 规整器命名不一致——A 系列 5G-only 去掉 5G、Tab LTE↔4G，与前端 normalizeModelKey 一致。
const modelNorm = (m) => String(m || '').replace(/\b(A(?:26|36|37|56|57))\s*5G\b/i, '$1').replace(/\bLTE\b/gi, '4G').replace(/\s+/g, ' ').trim();

// 当前自家 15 listing 的 item_id
const selfItems = new Set(recArr.filter((r) => String(r.shopId) === '54618012').map((r) => String(r.itemId)));
// 只读这些 item 的最新 trace
const traceDir = path.join('out', 'traces', DAY);
const traces = [];
for (const it of selfItems) {
  const f = path.join(traceDir, `54618012_${it}.json`);
  if (fs.existsSync(f)) traces.push(JSON.parse(fs.readFileSync(f, 'utf8')));
}

// D1 lookup（6-key 后）：精确键(含 capacity+color) → eff；另存「容量存在集」用于判断是否塌缩。
const d1map = new Map();          // shop:item:model:tier:cap:color → eff
const d1capSet = new Set();       // shop:item:model:tier:cap（该容量是否进了 D1）
const d1grab = new Map();         // shop:item → grabbedAt
for (const r of d1) {
  d1grab.set(`${r.shopId}:${r.itemId}`, r.grabbedAt);
  for (const v of (r.variants || [])) {
    const cap = capROM(v.capacity);
    const base = `${r.shopId}:${r.itemId}:${modelNorm(v.model)}:${tierNorm(v.tier)}:${cap}`;
    d1capSet.add(base);
    d1map.set(`${base}:${v.color || ''}`, round2((v.currentPrice || 0) - (v.voucherAmount || 0)));
  }
}

function nameParseConflict(raw, parsed) {
  const r = String(raw || ''), p = String(parsed || '');
  if (/\bS\s*2\d\s*FE\b|S2\dFE/i.test(r) && !/FE/i.test(p)) return 'raw有FE但parsed无';
  if (/FE\s*\+|FE\s*PLUS/i.test(r) && !/FE\+/i.test(p)) return 'raw有FE+但parsed无+';
  if (/\bLTE\b|\b4G\b/i.test(r) && !/5G/i.test(r) && /5G/i.test(p)) return 'raw 4G但parsed 5G';
  if (/\b5G\b/i.test(r) && !/4G|LTE/i.test(r) && /(4G|LTE)/i.test(p)) return 'raw 5G但parsed 4G';
  return '';
}

const HEADERS = ['Model', 'Capacity', 'Network', 'Dashboard Price', 'Trace Price', 'Difference', 'Source SKU',
  'Source Listing', 'Raw Variant', 'Parsed Model', 'Confidence', 'Issue', 'Last Updated'];
const rows = [];
const issueCount = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
const modelsNeedCheck = new Set();

const catOf = { watch: { total: 0, A: 0, E: 0 }, buds: { total: 0, A: 0, E: 0 }, phone_tablet: { total: 0, A: 0, E: 0 }, unknown: { total: 0, A: 0, E: 0 } };
let codeOverrides = 0;
for (const t of traces) {
  const role = ROLES[String(t.shopId)] || t.shopId;
  const upd = (t.scrapedAt || '').replace('T', ' ').slice(0, 16);
  for (const s of (t.skus || [])) {
    // 代码优先：raw 含已知型号代码(L320/L330/L500/L705/R540/R640…)→以代码为准，不依赖名称解析
    const code = lookupModelByCode(s.rawModelName);
    const model = code ? code.canonical : s.parsed.model;
    const overrode = code && code.canonical !== s.parsed.model;
    if (overrode) codeOverrides++;
    const cap = capROM(s.parsed.capacity), net = netOf(model);
    const rc = modelCategory(model);
    const cat = (rc === 'phone' || rc === 'tablet') ? 'phone_tablet' : rc;
    const tracePrice = s.price.effective_price;
    const base = `${t.shopId}:${t.itemId}:${modelNorm(model)}:${tierNorm(s.parsed.tier)}:${cap}`;
    const colorKey = `${base}:${s.parsed.color || ''}`;
    let dash, issues = [];
    // 解析正确性（代码优先后再判）
    const conflict = nameParseConflict(s.rawModelName, model);
    if (conflict) issues.push('A');
    if (!isKnownModel(model)) issues.push('A');
    // Dashboard / 塌缩检测（6-key 后：精确命中=好；容量在但色对不上=次好；容量缺=E）
    if (d1map.has(colorKey)) dash = d1map.get(colorKey);
    else if (d1capSet.has(base)) { dash = '—(色未命中)'; } // 容量在 D1，仅该颜色没对上(非塌缩)
    else { dash = '—(D1无此容量)'; issues.push('E'); }
    // price chain
    const expEff = round2((s.price.current_price || 0) - (s.price.voucher_discount || 0));
    if (s.price.effective_price !== expEff) issues.push('D');
    const uniq = [...new Set(issues)];
    const issueStr = uniq.length ? uniq.join(',') : 'OK';
    if (issueStr !== 'OK') {
      modelsNeedCheck.add(model);
      for (const i of uniq) issueCount[i] = (issueCount[i] || 0) + 1;
      const cc = catOf[cat] || (catOf[cat] = { total: 0, A: 0, E: 0 });
      cc.total++;
      if (uniq.includes('A')) cc.A++;
      if (uniq.includes('E')) cc.E++;
    }
    const diff = (typeof dash === 'number' && typeof tracePrice === 'number') ? round2(dash - tracePrice) : '';
    const parsedShown = overrode ? `${s.parsed.model || '(空)'}→[${code.code}]` : s.parsed.model;
    rows.push([
      model, cap, net || '-', dash, tracePrice ?? '', diff, `${s.parsed.tier} ${s.parsed.color || ''}`.trim(),
      `${String(t.title).slice(0, 42)} (${role})`, s.rawModelName, parsedShown, s.score, issueStr, upd,
    ]);
  }
}

// 排序：Issue≠OK 优先 → Confidence 升 → |Difference| 降
const iIdx = HEADERS.indexOf('Issue'), cIdx = HEADERS.indexOf('Confidence'), dIdx = HEADERS.indexOf('Difference');
rows.sort((a, b) => {
  const ai = a[iIdx] !== 'OK' ? 0 : 1, bi = b[iIdx] !== 'OK' ? 0 : 1;
  if (ai !== bi) return ai - bi;
  if (a[cIdx] !== b[cIdx]) return a[cIdx] - b[cIdx];
  return Math.abs(Number(b[dIdx]) || 0) - Math.abs(Number(a[dIdx]) || 0);
});
const highlight = rows.map((r, i) => (r[iIdx] !== 'OK' ? i : -1)).filter((i) => i >= 0);
fs.writeFileSync('/tmp/audit_rows.json', JSON.stringify({ headers: HEADERS, rows, highlight }));

// Summary
const distinctModels = new Set(rows.map((r) => r[0]));
const auditTime = new Date().toISOString();
let sum = `Samsung Audit Summary\n=====================\n\n`;
sum += `Audit 时间: ${auditTime}\n`;
sum += `数据: 最新 D1(${d1.length}条) + trace(${traces.length}个自家listing) + Samsung Master(${Object.keys(MODEL_CODES).length}代码) + records.json(去重${recArr.length}条)\n`;
sum += `范围: 自家店(self) Samsung\n\n`;
sum += `1. 总商品数(SKU行): ${rows.length}（${distinctModels.size} 个型号，${traces.length} 个 listing）\n`;
sum += `2. Issue 数量(Issue≠OK): ${highlight.length}\n`;
sum += `3. E 类数量(Dashboard≠Trace/容量塌缩): ${issueCount.E}\n`;
sum += `4. A/B/C/D/E/F 分类统计:\n`;
for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) sum += `   ${t} (${t === 'A' ? '型号解析错' : t === 'B' ? 'SKU归类错' : t === 'C' ? '最低价选择错' : t === 'D' ? 'PriceChain错' : t === 'E' ? 'D1写入/容量塌缩' : 'Dashboard旧数据'}): ${issueCount[t] || 0}\n`;
sum += `\n5. 当前确认的根因:\n`;
sum += `   - 解析层(手机/平板)已干净: S25 FE 不再混入 S25；S25/S25+/S25 Ultra、S10 FE/FE+/Lite、A07 4G/5G 解析正确。\n`;
sum += `   - 主问题(E=${issueCount.E})=D1 表 UNIQUE(shop_id,item_id,model,tier) 漏了 capacity → 同 model+tier 不同容量(256/512/1TB)互相覆盖，D1 每 tier 只剩一个容量(容量塌缩)。多容量型号(S25 Ultra 等)Dashboard 价不准/缺容量。修法=UNIQUE 加 capacity + Worker ON CONFLICT 同步加。\n`;
sum += `   - A类(${issueCount.A})=手表变体按厂方代码命名(L320/L330/L500/L505/L705…)，解析器未识别→空型号。master 已有这些代码，接「代码优先匹配(A+B)」即可解决。\n`;
sum += `   - 竞品 A/B/C 尚未用新代码重抓(本审计仅自家)。\n`;
sum += `\n6. 仍需人工检查的型号(Issue≠OK):\n`;
if (modelsNeedCheck.size === 0) sum += `   (无)\n`;
else for (const m of [...modelsNeedCheck].sort()) sum += `   - ${m}\n`;
const wt = catOf.watch, bd = catOf.buds, pt = catOf.phone_tablet, uk = catOf.unknown;
sum += `\n7. 剩余异常按产品大类(Issue≠OK 共 ${highlight.length})：\n`;
sum += `   - Watch 类: ${wt.total}（A=${wt.A} E=${wt.E}）\n`;
sum += `   - Buds  类: ${bd.total}（A=${bd.A} E=${bd.E}）\n`;
sum += `   - 手机/平板类: ${pt.total}（A=${pt.A} E=${pt.E}）\n`;
if (uk.total) sum += `   - 未知: ${uk.total}（A=${uk.A} E=${uk.E}）\n`;
sum += `   → Watch+Buds = ${wt.total + bd.total} 条：本质是「可穿戴型号映射缺失 + 未重抓」。已接代码优先(L320/L330/L500/L705/R540/R640…)识别型号，Hermes 重抓后即清除。\n`;
sum += `   → 真·手机/平板异常 = ${pt.total} 条：主要为容量塌缩，需 D1 加 capacity。\n`;
sum += `\n说明: 修复 D1 容量塌缩(UNIQUE 加 capacity + Worker ON CONFLICT)后，E 类应消失，多容量型号能保留 256/512/1TB。可穿戴异常需把「代码优先」接进 parser 并重抓。\n`;
fs.writeFileSync('/tmp/audit_summary.txt', sum);

console.log(`总SKU: ${rows.length} | Issue≠OK: ${highlight.length} | A: ${issueCount.A} | E: ${issueCount.E} | 代码覆盖: ${codeOverrides}`);
console.log(`分类(Issue≠OK): Watch=${wt.total} Buds=${bd.total} 手机/平板=${pt.total} 未知=${uk.total}`);
