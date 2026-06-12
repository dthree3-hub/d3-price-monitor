// sweep-all.mjs — D3 all：抓全店一轮（自家 self + 对手 A/B/C，共 ~106 条），
// 抓完自动同步云端 → D1 → 网页。一次性，不带定时（跑完即停）。
// 跑法：scripts\windows\start-all-once.ps1，或双击「D3 all.bat」。
import { runSweep } from './runOnce.mjs';

runSweep({ group: 'all', reason: 'D3-all' })
  .then((r) => {
    console.log(`\n[D3 all] 完成：抓 ${r.scraped}/${r.products} 条，失败 ${r.failures.length}${r.aborted ? '（碰风控提前停止）' : ''}`);
    if (r.failures.length) for (const f of r.failures) console.log(`  - ${f}`);
    const cs = r.cloudSync || {};
    if (cs.ok) console.log(`[D3 all] ✅ 云端同步成功（${cs.info}）；网页 3 分钟内自动刷新。`);
    else console.log(`[D3 all] ❌ 云端同步失败（${cs.info || '未知'}）—— 数据没进网页！`);
  })
  .catch((e) => {
    console.error(`[D3 all] 失败：${e.message || String(e)}`);
    process.exit(1);
  });
