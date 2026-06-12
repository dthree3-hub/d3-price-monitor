// sweep-self.mjs — D3 only：只抓我们自己店(self, shopId 54618012)一轮，
// 抓完自动同步云端 → D1 → 网页(3 分钟内自动刷)。与定时 Hermes 分开，手动按需跑。
// 跑法：scripts\windows\start-self.ps1，或双击「D3 only.bat」。
import { runSweep } from './runOnce.mjs';

runSweep({ group: 'self', reason: 'D3-only-self' })
  .then((r) => {
    console.log(`\n[D3 only] 完成：抓 ${r.scraped}/${r.products} 条，失败 ${r.failures.length}${r.aborted ? '（碰风控提前停止）' : ''}`);
    if (r.failures.length) for (const f of r.failures) console.log(`  - ${f}`);
    const cs = r.cloudSync || {};
    if (cs.ok) console.log(`[D3 only] ✅ 云端同步成功（${cs.info}）；网页 3 分钟内自动刷新。`);
    else console.log(`[D3 only] ❌ 云端同步失败（${cs.info || '未知'}）—— 数据没进网页！`);
  })
  .catch((e) => {
    console.error(`[D3 only] 失败：${e.message || String(e)}`);
    process.exit(1);
  });
