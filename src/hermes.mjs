import { loadEnvFile, logHermes } from './lib-hermes.mjs';
import { runOnce } from './runOnce.mjs';
import { syncLatestCloudRecords } from './sync-cloud-retry.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadEnvFile();
  const minutes = Number(process.env.HERMES_INTERVAL_MINUTES || 60);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('HERMES_INTERVAL_MINUTES 必须是正数');
  }
  const cloudSyncEnabled = process.env.HERMES_SYNC_CLOUD !== '0';
  if (cloudSyncEnabled) {
    process.env.HERMES_SYNC_CLOUD = '0';
    logHermes('Hermes 云端同步改由 retry uploader 处理。');
  }

  logHermes(`Hermes 启动，每 ${minutes} 分钟运行一次`);
  console.log(`Hermes 已启动，每 ${minutes} 分钟运行一次`);

  while (true) {
    const startedAt = new Date().toISOString();
    try {
      const result = await runOnce();
      const changed = result.changes.filter((change) => change.status !== 'same').length;
      let cloudLabel = '';
      if (cloudSyncEnabled) {
        try {
          const cloud = await syncLatestCloudRecords({ force: true });
          if (cloud.synced) {
            cloudLabel = `，云端同步成功 ${cloud.records} 条`;
            logHermes(`云端 retry 同步成功: ${cloud.url}（${cloud.records} 条，${cloud.bytes} bytes，第 ${cloud.attempt} 次）`);
          } else {
            cloudLabel = `，云端同步跳过: ${cloud.reason || 'unknown'}`;
            logHermes(`云端 retry 同步跳过: ${cloud.reason || 'unknown'}`);
          }
        } catch (error) {
          cloudLabel = '，云端同步失败';
          logHermes(`云端 retry 同步失败: ${error.message || String(error)}`);
        }
      }
      const totalBatches = result.batchSize > 0
        ? Math.ceil((result.totalProducts || 0) / result.batchSize)
        : 0;
      const remainingProducts = Number.isFinite(Number(result.totalProducts)) && Number.isFinite(Number(result.nextBatchCursor))
        ? Math.max(0, Number(result.totalProducts) - Number(result.nextBatchCursor))
        : null;
      const remainingBatches = remainingProducts != null && result.batchSize > 0
        ? Math.ceil(remainingProducts / result.batchSize)
        : null;
      const batchLabel = result.batchNumber
        ? `第 ${result.batchNumber} 批${totalBatches ? ` / 共 ${totalBatches} 批` : ''}`
        : '当前批次未知';
      const cursorLabel = Number.isFinite(Number(result.batchCursor))
        ? `cursor ${result.batchCursor} -> ${result.nextBatchCursor}`
        : 'cursor 未知';
      const remainingLabel = remainingProducts == null
        ? ''
        : (remainingProducts === 0
          ? '，本圈已跑完，下轮从第 1 批开始'
          : `，还剩 ${remainingProducts} 条 / ${remainingBatches} 批`);
      const summary = `本轮完成: ${batchLabel}，${cursorLabel}${remainingLabel}，成功 ${result.scraped}/${result.products}，变化 ${changed}，失败 ${result.failures.length}${cloudLabel}`;
      console.log(`[${startedAt}] ${summary}`);
      logHermes(summary);
    } catch (error) {
      const message = `[${startedAt}] Hermes 本轮失败: ${error.message || String(error)}`;
      console.error(message);
      logHermes(message);
    }

    await sleep(minutes * 60 * 1000);
  }
}

main().catch((error) => {
  console.error(`Hermes 启动失败: ${error.message || String(error)}`);
  process.exit(1);
});
