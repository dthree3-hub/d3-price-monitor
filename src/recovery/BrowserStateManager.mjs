// BrowserStateManager — 暂停任务时，把「现场」安全落盘。
//   - 当前 URL / 标题 / 拦路类型
//   - 任务上下文（哪个商品、哪一批、调用方塞进来的任意 JSON）
//   - 截图（PNG，存盘 + 返回 Buffer 给 Telegram）
//   - 一个 pending.json 检查点：即使 Hermes 重启，也知道「上次卡在哪、要恢复什么」
//
// 注意：截图可能包含页面上的敏感信息，但它只发到用户自己的 Telegram、只存在
// 本地 out/recovery/（已 gitignore）。task context 由调用方保证不含凭据。

import fs from 'node:fs';
import path from 'node:path';
import { recoveryDir, pendingCheckpointFile, redactUrl } from './events.mjs';

function tsSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// 用 CDP 截一张图，返回 { buffer, file }。失败返回 { buffer: null }。
export async function captureScreenshot({ Page }, type = 'page') {
  try {
    const shot = await Page.captureScreenshot({ format: 'png' });
    if (!shot?.data) return { buffer: null, file: null };
    const buffer = Buffer.from(shot.data, 'base64');
    fs.mkdirSync(recoveryDir, { recursive: true });
    const file = path.join(recoveryDir, `${tsSlug()}-${type}.png`);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { buffer, file };
  } catch {
    return { buffer: null, file: null };
  }
}

// 保存现场 + 写检查点。detection 是 VerificationDetector 的结果。
export async function capture(cdp, { detection, taskContext = {} } = {}) {
  const { buffer, file } = await captureScreenshot(cdp, detection?.type || 'page');

  const checkpoint = {
    createdAt: new Date().toISOString(),
    type: detection?.type || 'unknown',
    title: detection?.title || '',
    url: detection?.url || '',          // 检查点里留原始 URL（本地文件，便于真正恢复导航）
    displayUrl: redactUrl(detection?.url || ''),
    reasons: detection?.reasons || [],
    screenshotPath: file,
    taskContext,                         // 调用方负责不放凭据
    status: 'waiting',
  };

  writeCheckpoint(checkpoint);

  return { screenshotBuffer: buffer, screenshotPath: file, checkpoint };
}

export function writeCheckpoint(checkpoint) {
  fs.mkdirSync(path.dirname(pendingCheckpointFile), { recursive: true });
  fs.writeFileSync(pendingCheckpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
}

export function loadPending() {
  if (!fs.existsSync(pendingCheckpointFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(pendingCheckpointFile, 'utf8'));
  } catch {
    return null;
  }
}

export function updatePendingStatus(status) {
  const cp = loadPending();
  if (!cp) return;
  cp.status = status;
  cp.updatedAt = new Date().toISOString();
  writeCheckpoint(cp);
}

export function clearPending() {
  try {
    if (fs.existsSync(pendingCheckpointFile)) fs.unlinkSync(pendingCheckpointFile);
  } catch { /* 删不掉也无所谓 */ }
}
