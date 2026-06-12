// ScraperAPI Free Trial 验证：跑 config/test-links.txt 里的链接，
// 记录①成功率 ②每个消耗多少 credits ③整体判定（<70% 喊停）。
//
// 用法：node src/test-scraperapi.mjs
// 前置：.env 里填 SCRAPERAPI_KEY；config/test-links.txt 一行一个虾皮商品链接。

import fs from 'node:fs';
import { scrapeViaSA, saAccount } from './scraperapi.mjs';

// 极简读 .env
for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').split('\n') : [])) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const PASS_THRESHOLD = 0.70; // 成功率低于这个就不用 ScraperAPI

function readLinks() {
  const f = 'config/test-links.txt';
  if (!fs.existsSync(f)) { console.error('缺 config/test-links.txt（一行一个链接）'); process.exit(1); }
  return fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

async function main() {
  const links = readLinks();
  console.log(`\n准备测试 ${links.length} 个链接，阈值：成功率 ≥ ${PASS_THRESHOLD * 100}% 才继续\n`);

  let before = null;
  try { before = await saAccount(); console.log(`账户已用 credits（测试前）：${before.requestCount}/${before.requestLimit}\n`); }
  catch (e) { console.log('（查账户失败，仍按响应头估算 credits）', e.message, '\n'); }

  const rows = [];
  let creditFromHeaders = 0;

  for (let i = 0; i < links.length; i++) {
    const url = links[i];
    const t0 = Date.now();
    let r;
    try { r = await scrapeViaSA(url); } catch (e) { r = { ok: false, reason: '异常:' + e.message, attempts: [] }; }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const cost = (r.attempts || []).reduce((s, a) => s + (a.cost || 0), 0);
    creditFromHeaders += cost;

    if (r.ok) {
      const cheapest = Math.min(...r.variants.map(v => v.current).filter(x => x != null));
      console.log(`[${i + 1}/${links.length}] ✅ ${r.title?.slice(0, 40)} | ${r.variants.length}款 最低RM${cheapest} | ${r.tier}档 ${secs}s 约${cost}credits`);
    } else {
      console.log(`[${i + 1}/${links.length}] ❌ ${r.reason} | ${secs}s 约${cost}credits`);
    }
    rows.push({ n: i + 1, ok: r.ok, tier: r.tier, variants: r.ok ? r.variants.length : 0, cost, secs, reason: r.ok ? '' : r.reason });
  }

  let after = null;
  try { after = await saAccount(); } catch {}

  // ===== 汇总 =====
  const okCount = rows.filter(r => r.ok).length;
  const rate = okCount / rows.length;
  const creditByAccount = before && after ? after.requestCount - before.requestCount : null;

  console.log('\n========== 测试结果 ==========');
  console.log(`成功率：${okCount}/${rows.length} = ${(rate * 100).toFixed(0)}%`);
  if (creditByAccount != null) console.log(`实际消耗 credits（账户差值，最准）：${creditByAccount}`);
  console.log(`消耗 credits（响应头累计，参考）：${creditFromHeaders}`);
  if (okCount) console.log(`平均每个成功链接约：${(creditFromHeaders / okCount).toFixed(1)} credits`);
  if (after) console.log(`账户剩余：${after.requestLimit - after.requestCount} credits`);

  console.log('\n失败明细：');
  const fails = rows.filter(r => !r.ok);
  if (!fails.length) console.log('  （全部成功）');
  else fails.forEach(r => console.log(`  #${r.n}: ${r.reason}`));

  console.log('\n========== 判定 ==========');
  if (rate >= PASS_THRESHOLD) {
    console.log(`✅ 成功率 ${(rate * 100).toFixed(0)}% ≥ ${PASS_THRESHOLD * 100}% → 可以接 dashboard，继续用 ScraperAPI`);
  } else {
    console.log(`🛑 成功率 ${(rate * 100).toFixed(0)}% < ${PASS_THRESHOLD * 100}% → 按你的规则：不要继续用 ScraperAPI，换方案`);
  }
  console.log('');
}

main().catch(e => { console.error('测试崩了：', e); process.exit(1); });
