// Verification Recovery Skill — 对外统一入口。
//
// 高层用法（最常用）：把对 Shopee 的 CDP 抓取包进恢复流程。
//   import { guardCdpScrape } from './recovery/index.mjs';
//   const scraped = await guardCdpScrape(productUrl, { taskContext });
//
// 低层模块也都导出，方便单独复用 / 单测：
//   VerificationDetector, SessionManager, BrowserStateManager, TelegramNotifier, ResumeController

import { scrapeProductViaCDP } from '../scraper.mjs';
import { attachToShopeeTarget } from './cdp.mjs';
import { detectViaCDP } from './VerificationDetector.mjs';
import * as SessionManager from './SessionManager.mjs';
import { capture as captureBrowserState } from './BrowserStateManager.mjs';
import { TelegramNotifier } from './TelegramNotifier.mjs';
import { runWithRecovery } from './ResumeController.mjs';

export * as VerificationDetector from './VerificationDetector.mjs';
export * as SessionManager from './SessionManager.mjs';
export * as BrowserStateManager from './BrowserStateManager.mjs';
export { TelegramNotifier, readManualSignal, writeManualSignal } from './TelegramNotifier.mjs';
export { runWithRecovery } from './ResumeController.mjs';
export { attachToShopeeTarget } from './cdp.mjs';
export * from './events.mjs';

// 用一条 CDP attachment 组装 ResumeController 需要的 adapter。
function buildCdpAdapter(att) {
  return {
    async detect() {
      return detectViaCDP({ Runtime: att.Runtime });
    },
    async captureState({ detection, taskContext }) {
      return captureBrowserState({ Page: att.Page }, { detection, taskContext });
    },
    async captureSession() {
      const session = await SessionManager.captureViaCDP({ Network: att.Network, Runtime: att.Runtime });
      return SessionManager.save(session); // 返回脱敏 summary
    },
    async restoreSession() {
      return SessionManager.restoreViaCDP({ Network: att.Network, Runtime: att.Runtime });
    },
  };
}

// guardCdpScrape：等价于 scrapeProductViaCDP(url)，但被拦时自动走人工恢复再重试。
export async function guardCdpScrape(url, {
  endpoint = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222',
  scrapeOptions = {},
  taskContext = {},
  notifier = new TelegramNotifier(),
} = {}) {
  const att = await attachToShopeeTarget({ endpoint, url });
  const adapter = buildCdpAdapter(att);
  try {
    return await runWithRecovery(() => scrapeProductViaCDP(url, scrapeOptions), {
      adapter,
      notifier,
      taskContext: { url, ...taskContext },
    });
  } finally {
    await att.close();
  }
}
