// Verification Recovery — 公共常量、事件日志、错误类型。
// 这一层不碰浏览器，只负责「分类口径 + 日志事件名 + 错误对象」。
// 安全要求：日志里永远不写 cookie / token / 密码，只写计数和已脱敏字段。

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../lib-records.mjs';
import { logHermes } from '../lib-hermes.mjs';

// 五类需要人工介入的拦路页。none = 页面正常。
export const VERIFICATION_TYPES = Object.freeze({
  NONE: 'none',
  CAPTCHA: 'captcha',
  CLOUDFLARE: 'cloudflare',
  LOGIN_REQUIRED: 'login_required',
  ACCESS_DENIED: 'access_denied',
  SESSION_EXPIRED: 'session_expired',
  ANTI_BOT: 'anti_bot',
});

// 需求第 5 条要求记录的生命周期事件，名字固定，方便后续 grep / 报表。
export const RECOVERY_EVENTS = Object.freeze({
  VERIFICATION_DETECTED: 'verification_detected',
  WAITING_FOR_USER: 'waiting_for_user',
  VERIFICATION_COMPLETED: 'verification_completed',
  SESSION_RESTORED: 'session_restored',
  TASK_RESUMED: 'task_resumed',
  ABORTED: 'aborted',
  TIMEOUT: 'timeout',
});

export const recoveryDir = path.join(projectRoot, 'out', 'recovery');
export const recoveryEventLog = path.join(recoveryDir, 'events.log');
export const pendingCheckpointFile = path.join(recoveryDir, 'pending.json');
export const recoverySignalFile = path.join(recoveryDir, 'signal');

// 抛给上层、表示「这是一个可人工恢复的拦路页」的错误。
export class VerificationRequiredError extends Error {
  constructor(type, detail = {}) {
    super(`verification required: ${type}`);
    this.name = 'VerificationRequiredError';
    this.type = type;
    this.detail = detail;
  }
}

// 人工选择放弃本条任务时抛出。
export class VerificationAbortedError extends Error {
  constructor(detail = {}) {
    super('verification aborted by operator');
    this.name = 'VerificationAbortedError';
    this.detail = detail;
  }
}

// 等待人工超时。
export class VerificationTimeoutError extends Error {
  constructor(detail = {}) {
    super('verification wait timed out');
    this.name = 'VerificationTimeoutError';
    this.detail = detail;
  }
}

const SECRET_KEY_RE = /cookie|token|password|passwd|secret|authorization|auth|session(id)?|value|credential|storage/i;

// 防御性脱敏：任何 key 命中敏感词，一律替换成 [redacted]。
// 我们本来就只往日志里塞「安全字段」，这层是双保险。
export function redact(detail) {
  if (detail == null || typeof detail !== 'object') return detail;
  if (Array.isArray(detail)) return detail.map((item) => redact(item));
  const out = {};
  for (const [key, val] of Object.entries(detail)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = typeof val === 'number' ? val : '[redacted]';
    } else if (val && typeof val === 'object') {
      out[key] = redact(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// URL 也脱敏：去掉 query string（有些站点把 token 放 query 里）。
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || '').split('?')[0];
  }
}

// 统一写事件日志：既进 out/recovery/events.log（结构化），也进 hermes.log（人能看到）。
export function logRecoveryEvent(event, detail = {}) {
  const safe = redact({ ...detail });
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...safe });
  try {
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.appendFileSync(recoveryEventLog, `${line}\n`);
  } catch {
    /* 日志失败不能拖垮主流程 */
  }
  const summary = detail.url ? `${event} (${detail.type || '-'}) ${redactUrl(detail.url)}` : `${event} (${detail.type || '-'})`;
  logHermes(`[recovery] ${summary}`);
  return line;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
