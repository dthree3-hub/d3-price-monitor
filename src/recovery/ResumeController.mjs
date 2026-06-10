// ResumeController — 编排「检测 → 暂停 → 通知 → 等人工 → 恢复会话 → 重跑」。
//
// 它对传输层不耦合：只依赖一个 adapter 对象（由 index.mjs 用 CDP 组装）。
// adapter 形状：
//   detect()            -> { blocked, type, title, url, reasons }
//   captureState(ctx)   -> { screenshotBuffer, screenshotPath, checkpoint }
//   captureSession()    -> sessionSummary（同时已落盘）
//   restoreSession()    -> { restored, ... }（把已验证会话灌回，供复用）
//
// 完成判定：主用轮询 adapter.detect()（人把验证做完，页面自然 unblock）；
// 兜底读手动信号 resume/abort（见 TelegramNotifier.readManualSignal）。

import {
  RECOVERY_EVENTS,
  VERIFICATION_TYPES,
  VerificationAbortedError,
  VerificationTimeoutError,
  logRecoveryEvent,
  sleep,
} from './events.mjs';
import { classifyError } from './VerificationDetector.mjs';
import { clearPending, updatePendingStatus } from './BrowserStateManager.mjs';
import { readManualSignal } from './TelegramNotifier.mjs';

// 跑任务，捕获结果/异常。
async function tryTask(taskFn) {
  try {
    return { ok: true, result: await taskFn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// 等待页面恢复正常：轮询 detect()，或读到 abort/resume 信号。
async function waitForClear(adapter, { maxWaitMinutes, pollSec, notifier, detection }) {
  const deadline = Date.now() + maxWaitMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    const signal = readManualSignal();
    if (signal === 'abort') return { outcome: 'abort' };
    if (signal === 'resume') return { outcome: 'resume' };

    // anti_bot 软拦不靠 DOM 判「清掉了」(页面未必有可识别的验证元素),
    // 只认人工 /resume(或 /abort)或超时 —— 这样它会真的等你把验证过完再续。
    if (detection?.type !== VERIFICATION_TYPES.ANTI_BOT) {
      const current = await adapter.detect().catch(() => null);
      if (current && !current.blocked) return { outcome: 'cleared', detection: current };
    }

    await sleep(Math.min(pollSec * 1000, Math.max(0, deadline - Date.now())));
  }
  return { outcome: 'timeout' };
}

// 主入口：把一个任务函数包进恢复流程。
//   taskFn      : () => Promise<result>  实际工作（如抓一个商品）
//   adapter     : 见上
//   notifier    : TelegramNotifier 实例
//   taskContext : 任意可序列化上下文（哪个商品/批次），会进检查点
//   maxWaitMinutes / pollSec : 等人工的上限与轮询间隔
//   isRecoverable(error) : 可选，判断某个异常是否该走恢复（默认看 detect 结果）
export async function runWithRecovery(taskFn, {
  adapter,
  notifier,
  taskContext = {},
  maxWaitMinutes = Number(process.env.HERMES_RECOVERY_MAX_WAIT_MIN || 20),
  pollSec = Number(process.env.HERMES_RECOVERY_POLL_SEC || 8),
  maxRounds = Number(process.env.HERMES_RECOVERY_MAX_ROUNDS || 2),
} = {}) {
  for (let round = 0; ; round += 1) {
    const attempt = await tryTask(taskFn);

    // 决定是否进入恢复：先看任务是否抛了「可恢复」异常，再看页面当前状态。
    let detection = null;
    if (!attempt.ok && attempt.error?.type && attempt.error.type !== VERIFICATION_TYPES.NONE) {
      detection = { blocked: true, type: attempt.error.type, title: '', url: taskContext.url || '', reasons: ['from-error'] };
    } else if (!attempt.ok && classifyError(attempt.error) !== VERIFICATION_TYPES.NONE) {
      // 把抛出的错误归类(如 Shopee 90309999 反爬码)→ 暂停那一条,等人工过验证再续
      detection = { blocked: true, type: classifyError(attempt.error), title: '', url: taskContext.url || '', reasons: ['from-error'] };
    } else {
      detection = await adapter.detect().catch(() => null);
    }

    // 任务成功且页面不是拦路页 -> 正常返回。
    if (attempt.ok && (!detection || !detection.blocked)) {
      return attempt.result;
    }

    // 任务失败，但也不是拦路页 -> 是别的错误，原样抛出，不归我管。
    if (!attempt.ok && (!detection || !detection.blocked)) {
      throw attempt.error;
    }

    // 只有「人能动手解决」的拦路页才暂停等你：验证码 / Cloudflare / 登录 / 会话过期。
    // access_denied / anti_bot 这种静默软拦没验证可点 —— 不暂停、不干等,
    // 当普通失败处理(下一圈再补抓),避免「页面没东西可过却卡 5 分钟」。
    const ACTIONABLE_TYPES = new Set([
      VERIFICATION_TYPES.CAPTCHA,
      VERIFICATION_TYPES.CLOUDFLARE,
      VERIFICATION_TYPES.LOGIN_REQUIRED,
      VERIFICATION_TYPES.SESSION_EXPIRED,
    ]);
    if (!ACTIONABLE_TYPES.has(detection.type)) {
      logRecoveryEvent('skip_non_actionable', { type: detection.type, url: detection.url });
      if (attempt.ok) return attempt.result;
      throw attempt.error;
    }

    // 到这里：确认是拦路页。但已到最大轮次就别再等了。
    if (round >= maxRounds) {
      logRecoveryEvent(RECOVERY_EVENTS.TIMEOUT, { type: detection.type, url: detection.url, reason: 'max-rounds' });
      if (attempt.ok) return attempt.result;
      throw attempt.error;
    }

    // === 1) 检测到验证 ===
    logRecoveryEvent(RECOVERY_EVENTS.VERIFICATION_DETECTED, {
      type: detection.type, url: detection.url, title: detection.title, reasons: detection.reasons,
    });

    // 保存现场（URL/上下文/截图/检查点）+ 保存当前会话。
    const state = await adapter.captureState({ detection, taskContext }).catch(() => ({}));
    const savedSummary = await adapter.captureSession().catch(() => null);
    logRecoveryEvent('session_saved', { type: detection.type, ...(savedSummary || {}) });

    // 通知人（标题 + URL + 截图）。
    await notifier?.notifyVerificationRequired({
      type: detection.type,
      title: detection.title,
      url: detection.url,
      screenshotBuffer: state.screenshotBuffer,
    }).catch(() => {});

    // === 2) 等待人工 ===
    logRecoveryEvent(RECOVERY_EVENTS.WAITING_FOR_USER, { type: detection.type, url: detection.url, maxWaitMinutes });
    updatePendingStatus('waiting');

    const waited = await waitForClear(adapter, { maxWaitMinutes, pollSec, notifier, detection });

    if (waited.outcome === 'abort') {
      logRecoveryEvent(RECOVERY_EVENTS.ABORTED, { type: detection.type, url: detection.url });
      updatePendingStatus('aborted');
      clearPending();
      await notifier?.notifyAborted({ type: detection.type, url: detection.url }).catch(() => {});
      throw new VerificationAbortedError({ type: detection.type, url: detection.url });
    }

    if (waited.outcome === 'timeout') {
      logRecoveryEvent(RECOVERY_EVENTS.TIMEOUT, { type: detection.type, url: detection.url, minutes: maxWaitMinutes });
      updatePendingStatus('timeout');
      clearPending();
      await notifier?.notifyTimeout({ type: detection.type, url: detection.url, minutes: maxWaitMinutes }).catch(() => {});
      throw new VerificationTimeoutError({ type: detection.type, url: detection.url });
    }

    // === 3) 验证完成 ===
    logRecoveryEvent(RECOVERY_EVENTS.VERIFICATION_COMPLETED, { type: detection.type, url: detection.url, via: waited.outcome });

    // === 4) 会话已恢复（保存已验证会话，并灌回以便后续复用） ===
    const verifiedSummary = await adapter.captureSession().catch(() => null);
    await adapter.restoreSession?.().catch(() => {});
    logRecoveryEvent(RECOVERY_EVENTS.SESSION_RESTORED, { type: detection.type, ...(verifiedSummary || {}) });
    await notifier?.notifyResumed({ type: detection.type, url: detection.url, sessionSummary: verifiedSummary }).catch(() => {});

    // === 5) 重跑原任务 ===
    logRecoveryEvent(RECOVERY_EVENTS.TASK_RESUMED, { type: detection.type, url: detection.url, round: round + 1 });
    updatePendingStatus('resumed');
    clearPending();
    // 回到循环顶部重跑 taskFn；若再次被拦，最多 maxRounds 轮。
  }
}
