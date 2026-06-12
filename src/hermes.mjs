import { loadEnvFile, logHermes } from './lib-hermes.mjs';
import { runSweep } from './runOnce.mjs';
import { syncLatestCloudRecords } from './sync-cloud-retry.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 触发端点：网页按钮 POST 后，这里 GET?consume=1 返回 pending:true（并清标记）。
function triggerUrl() {
  const base = process.env.D3_CLOUD_RECORDS_URL || 'https://d3-price-worker.dthree.workers.dev/api/sync';
  return base.replace(/\/api\/sync$/, '/api/trigger');
}
async function manualTriggerRequested() {
  try {
    const res = await fetch(`${triggerUrl()}?consume=1`, { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.pending);
  } catch {
    return false;
  }
}

function parseHM(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min < 24 * 60 ? min : null;
}
function fmtHM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

async function main() {
  loadEnvFile();
  // 云端同步统一走 retry uploader（和旧版一致，更稳）；关掉 sweep 内部的直发，避免双发。
  process.env.HERMES_SYNC_CLOUD = '0';

  const times = (process.env.HERMES_RUN_TIMES || '09:30,13:00,16:30')
    .split(',').map(parseHM).filter((x) => x != null).sort((a, b) => a - b);
  if (!times.length) throw new Error('HERMES_RUN_TIMES 解析不出有效时间（格式如 09:30,13:00,16:30）');

  const startupSweep = process.env.HERMES_STARTUP_SWEEP !== '0';
  const minGapMin = Number(process.env.HERMES_MIN_SWEEP_GAP_MINUTES || 30);      // 两次抓取最小间隔，防意外连抓
  const manualMinGapMin = Number(process.env.HERMES_MANUAL_MIN_GAP_MINUTES || 5); // 手动触发最小间隔
  const pollSec = Number(process.env.HERMES_TRIGGER_POLL_SEC || 60);             // 听按钮的轮询间隔（只问自家 Worker，不碰 Shopee）

  let lastSweepAt = 0;
  const ranSlots = new Set(); // key: "YYYY-M-D HH:MM"，跑过的定时点（防当天重复）

  async function doSweep(group, reason) {
    const startedAt = new Date().toISOString();
    try {
      const r = await runSweep({ group, reason });
      lastSweepAt = Date.now();
      let cloudLabel = '';
      try {
        const cloud = await syncLatestCloudRecords({ force: true });
        cloudLabel = cloud.synced ? `，云端同步成功 ${cloud.records} 条` : `，云端同步跳过:${cloud.reason || ''}`;
      } catch {
        cloudLabel = '，云端同步失败';
      }
      const summary = `本轮完成(${reason}): 组=${group}，抓 ${r.scraped}/${r.products}，失败 ${r.failures.length}${r.aborted ? '(风控提前停止)' : ''}${cloudLabel}`;
      console.log(`[${startedAt}] ${summary}`);
      logHermes(summary);
    } catch (error) {
      const msg = `[${startedAt}] 本轮失败(${reason}): ${error.message || String(error)}`;
      console.error(msg);
      logHermes(msg);
    }
  }

  const schedLabel = times.map(fmtHM).join(' / ');
  logHermes(`Hermes 定时模式启动。每日 ${schedLabel}（首轮含自家店，其余只抓对手）。手动按钮随时可触发。`);
  console.log(`Hermes 已启动（定时 ${schedLabel}，首轮含自家店）`);

  // 启动先抓一轮对手；若临近某个定时点（minGap 内）则跳过，交给定时轮，避免短时间连抓两轮。
  if (startupSweep) {
    const cur = minutesNow();
    const nearScheduled = times.some((t) => t >= cur && t - cur <= minGapMin);
    if (nearScheduled) {
      logHermes(`启动跳过自动抓：临近定时点（${minGapMin} 分钟内），交给定时轮。`);
    } else {
      await doSweep('competitor', 'startup');
    }
  }

  while (true) {
    // 手动按钮（带最小间隔保护，防连按猛抓）
    if (await manualTriggerRequested()) {
      if (Date.now() - lastSweepAt >= manualMinGapMin * 60 * 1000) {
        await doSweep('competitor', 'manual');
      } else {
        logHermes(`收到手动触发，但距上次抓取不足 ${manualMinGapMin} 分钟，跳过（防连抓）。`);
      }
    }

    // 定时轮
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const cur = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < times.length; i += 1) {
      const slot = times[i];
      const key = `${todayKey} ${fmtHM(slot)}`;
      if (cur >= slot && cur < slot + 5 && !ranSlots.has(key)) {
        ranSlots.add(key);
        if (Date.now() - lastSweepAt < minGapMin * 60 * 1000) {
          logHermes(`定时点 ${fmtHM(slot)} 距上次抓取不足 ${minGapMin} 分钟，跳过本轮（防连抓）。`);
          continue;
        }
        const group = i === 0 ? 'all' : 'competitor'; // 首个（最早）时段含自家店
        await doSweep(group, `scheduled ${fmtHM(slot)}`);
      }
    }
    // 清掉非今天的已跑标记，避免 set 无限增长
    for (const k of ranSlots) {
      if (!k.startsWith(`${todayKey} `)) ranSlots.delete(k);
    }

    await sleep(pollSec * 1000);
  }
}

main().catch((error) => {
  console.error(`Hermes 启动失败: ${error.message || String(error)}`);
  process.exit(1);
});
