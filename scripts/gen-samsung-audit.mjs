// 生成 Samsung Audit：out/audit/samsung-audit.md + out/audit/_audit-rows.json（供 audit_xlsx.py 转 xlsx）。
// 只读：不改任何抓取/解析/写库逻辑。用 D1(out/_d1_audit.json) + out/traces/<DAY> + samsung-master。
import fs from 'node:fs';
import path from 'node:path';
import { lookupModelByCode, isKnownModel, MODEL_CODES } from '../src/samsung-master.mjs';

const DAY = process.env.AUDIT_DAY || new Date().toISOString().slice(0, 10);
const traceDir = path.join('out', 'traces', DAY);
const d1 = JSON.parse(fs.readFileSync('out/_d1_audit.json', 'utf8')).records;
const traces = fs.readdirSync(traceDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(traceDir, f), 'utf8')));
const ROLES = { '54618012': 'self', '116917349': 'A/DealDirect', '77792787': 'B/SprayGadget', '271823454': 'C/TAC' };
const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);
const netOf = (m) => (/\bWiFi\b/i.test(m) ? 'WiFi' : /\b5G\b/i.test(m) ? '5G' : /\b(4G|LTE)\b/i.test(m) ? '4G' : '');

const FOCUS = [
  { name: 'A07 4G 256GB', model: 'A07 4G' }, { name: 'A07 5G 256GB', model: 'A07 5G' },
  { name: 'S25', model: 'S25' }, { name: 'S25+', model: 'S25+' }, { name: 'S25 Ultra', model: 'S25 Ultra' },
  { name: 'S10 FE', model: 'Tab S10 FE WiFi' }, { name: 'S10 FE+', model: 'Tab S10 FE+ WiFi' },
  { name: 'S10 FE+ 5G', model: 'Tab S10 FE+ 5G' }, { name: 'S10 Lite WiFi', model: 'Tab S10 Lite WiFi' },
  { name: 'S10 Lite 5G', model: 'Tab S10 Lite 5G' },
];
const FOCUS_MODELS = new Set(FOCUS.map((f) => f.model));

function nameParseConflict(raw, parsed) {
  const r = String(raw || ''); const p = String(parsed || '');
  if (/\bS\s*2\d\s*FE\b|S2\dFE/i.test(r) && !/FE/i.test(p)) return 'raw 有 FE 但 parsed 无';
  if (/FE\s*\+|FE\s*PLUS/i.test(r) && !/FE\+/i.test(p)) return 'raw 有 FE+ 但 parsed 无 +';
  if (/\bS\s*2\d\s*(\+|PLUS)\b/i.test(r) && !/ultra/i.test(r) && !/S2\d\+/i.test(p)) return 'raw 有 + 但 parsed 无';
  if (/\bLTE\b|\b4G\b/i.test(r) && !/5G/i.test(r) && /5G/i.test(p)) return 'raw 4G/LTE 但 parsed 5G';
  if (/\b5G\b/i.test(r) && !/4G|LTE/i.test(r) && /(4G|LTE)/i.test(p)) return 'raw 5G 但 parsed 4G';
  return '';
}

// 收集 trace 全部 SKU
const allSkus = [];
for (const t of traces) for (const s of (t.skus || [])) {
  allSkus.push({
    role: ROLES[String(t.shopId)] || t.shopId, itemId: t.itemId, title: t.title,
    raw: s.rawModelName, label: s.variantLabel, model: s.parsed.model, cap: s.parsed.capacity,
    net: netOf(s.parsed.model), tier: s.parsed.tier, score: s.score, price: s.price,
  });
}
// D1 按 model 的最低 effective
function d1Low(model) {
  let lo = null;
  for (const r of d1) for (const v of (r.variants || [])) {
    if (String(v.model) !== model) continue;
    const eff = round2((v.currentPrice || 0) - (v.voucherAmount || 0));
    if (eff != null && (lo == null || eff < lo.eff)) lo = { eff, tier: v.tier, role: ROLES[String(r.shopId)] };
  }
  return lo;
}

const HEADERS = ['Model', 'Dashboard Price', 'Trace Price', 'Difference', 'Source SKU', 'Raw Variant',
  'Parsed Model', 'Parsed Capacity', 'Parsed Network', 'Confidence', 'Issue Category', 'Source Listing', 'Master Match'];
const rows = [];
let md = `# Samsung Audit Report\n\n生成: ${new Date().toISOString()} · D1 ${d1.length} 条 · trace ${traces.length} 文件(${DAY}) · master ${Object.keys(MODEL_CODES).length} 代码\n\n`;
md += `分类: A=型号解析错 B=SKU归类错 C=最低价选择错 D=PriceChain错 E=D1写入(D1≠trace) F=Dashboard旧数据\n\n配套 Excel: out/audit/samsung-audit.xlsx（Issue≠OK 标红，可排序）\n\n---\n\n`;

for (const fo of FOCUS) {
  const skus = allSkus.filter((s) => s.model === fo.model);
  const priced = skus.filter((s) => s.price.effective_price != null).sort((a, b) => a.price.effective_price - b.price.effective_price);
  const traceLow = priced[0] || null;
  const dLow = d1Low(fo.model);
  const dash = dLow ? dLow.eff : null;
  const tr = traceLow ? traceLow.price.effective_price : null;
  const diff = (dash != null && tr != null) ? round2(dash - tr) : '';

  md += `## ${fo.name}\n- Dashboard(D1)最低: ${dash != null ? `RM${dash}(${dLow.role} ${dLow.tier})` : '无'} · Trace最低: ${tr != null ? `RM${tr}` : '无'} · 差=${diff}\n`;
  if (traceLow) md += `- 最低价来源: raw=\`${traceLow.raw}\` parsed=\`${traceLow.model}\` ${traceLow.cap} ${traceLow.tier} score=${traceLow.score} ← ${String(traceLow.title).slice(0, 40)}(${traceLow.role})\n`;
  const badN = skus.filter((s) => nameParseConflict(s.raw, s.model)).length;
  md += `- SKU 数=${skus.length} 疑似错标=${badN} ${badN ? '❌' : '✓'}\n\n`;

  for (const s of skus) {
    const conflict = nameParseConflict(s.raw, s.model);
    const code = lookupModelByCode(`${s.raw} ${s.title}`);
    const codeConf = code && code.canonical !== s.model ? `代码${code.code}→${code.canonical}≠${s.model}` : '';
    const master = isKnownModel(s.model);
    const isLow = traceLow && s === traceLow;
    let issue = [];
    if (conflict || codeConf) issue.push('A');
    if (!master) issue.push('A');
    if (isLow && (conflict || codeConf)) issue.push('C');
    if (isLow && dash != null && tr != null && Math.abs(dash - tr) > 0.5 && !conflict && !codeConf) issue.push('E?');
    const issueStr = issue.length ? [...new Set(issue)].join(',') : 'OK';
    rows.push([
      fo.name, dash ?? '', tr ?? '', diff === '' ? '' : diff, s.label, s.raw,
      s.model, s.cap, s.net || '-', s.score, issueStr, `${String(s.title).slice(0, 45)} (${s.role})`, master ? 'Y' : 'N',
    ]);
  }
}

// 预排序：Issue≠OK 优先 → Confidence 升 → |Difference| 降
const issIdx = HEADERS.indexOf('Issue Category'), confIdx = HEADERS.indexOf('Confidence'), diffIdx = HEADERS.indexOf('Difference');
rows.sort((a, b) => {
  const ai = a[issIdx] !== 'OK' ? 0 : 1, bi = b[issIdx] !== 'OK' ? 0 : 1;
  if (ai !== bi) return ai - bi;
  if (a[confIdx] !== b[confIdx]) return a[confIdx] - b[confIdx];
  return Math.abs(Number(b[diffIdx]) || 0) - Math.abs(Number(a[diffIdx]) || 0);
});
const highlight = rows.map((r, i) => (r[issIdx] !== 'OK' ? i : -1)).filter((i) => i >= 0);

fs.mkdirSync('out/audit', { recursive: true });
fs.writeFileSync('out/audit/samsung-audit.md', md);
fs.writeFileSync('out/audit/_audit-rows.json', JSON.stringify({ headers: HEADERS, rows, highlight }));
console.log(`MD + rows.json 生成完毕：${rows.length} 行，${highlight.length} 个 Issue≠OK`);
