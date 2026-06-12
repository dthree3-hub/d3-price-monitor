// TelegramNotifier — 把「需要人工验证」推到 Telegram（带标题、URL、截图）。
//
// 复用 .env 里已有的 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID。
// 截图用 multipart(sendPhoto) 发；纯文字用 sendMessage。
//
// 关于「人工信号」：本项目里 telegram-bot.mjs 已经在 long-poll 同一个 bot，
// 如果这里再开一个 getUpdates 轮询，会互相抢消息。所以本类不轮询 Telegram，
// 而是读一个本地信号文件 out/recovery/signal（值为 resume / abort）。
// 主要的「完成判定」靠 ResumeController 轮询页面（人把验证做完，页面自然恢复）。
// signal 文件是手动兜底：可由网页、CLI，或给 telegram-bot 加一行 /resume 写入。

import fs from 'node:fs';
import path from 'node:path';
import { redactUrl, recoverySignalFile } from './events.mjs';

export class TelegramNotifier {
  constructor({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
    this.token = token;
    this.chatId = chatId;
    this.enabled = Boolean(token && chatId);
  }

  async sendMessage(text) {
    if (!this.enabled) return { ok: false, skipped: true };
    const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return res.json();
  }

  // 用 multipart 发图。Node 18+ 自带 FormData / Blob / fetch。
  async sendPhoto(buffer, caption) {
    if (!this.enabled) return { ok: false, skipped: true };
    if (!buffer) return this.sendMessage(caption);
    try {
      const form = new FormData();
      form.append('chat_id', String(this.chatId));
      if (caption) form.append('caption', caption.slice(0, 1024));
      form.append('photo', new Blob([buffer], { type: 'image/png' }), 'verification.png');
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) return this.sendMessage(caption); // 发图失败退化成文字
      return res.json();
    } catch {
      return this.sendMessage(caption);
    }
  }

  // 拦路页通知：标题 + 脱敏 URL + 类型 + 截图 + 操作提示。
  async notifyVerificationRequired({ type, title, url, screenshotBuffer }) {
    const caption = [
      '🛑 Hermes 需要你帮忙过验证',
      `类型: ${type}`,
      `标题: ${title || '(无标题)'}`,
      `链接: ${redactUrl(url)}`,
      '',
      '请在那台已打开的 Chrome 里手动完成验证 / 登录。',
      '我会自动检测，验证一过就继续原任务。',
      '（想直接跳过这条：回 /abort；想强制继续：回 /resume）',
    ].join('\n');
    return this.sendPhoto(screenshotBuffer, caption);
  }

  async notifyResumed({ type, url, sessionSummary }) {
    const lines = [
      '✅ 验证已通过，Hermes 继续原任务',
      `类型: ${type}`,
      `链接: ${redactUrl(url)}`,
    ];
    if (sessionSummary) {
      lines.push(`会话已保存: cookie ${sessionSummary.cookieCount} 个 / localStorage ${sessionSummary.localStorageKeys} 项`);
    }
    return this.sendMessage(lines.join('\n'));
  }

  async notifyAborted({ type, url }) {
    return this.sendMessage(['⏭️ 已按你的要求跳过这条', `类型: ${type}`, `链接: ${redactUrl(url)}`].join('\n'));
  }

  async notifyTimeout({ type, url, minutes }) {
    return this.sendMessage(['⌛ 等待人工超时，先跳过这条', `类型: ${type}`, `等待: ${minutes} 分钟`, `链接: ${redactUrl(url)}`].join('\n'));
  }
}

// 读手动信号文件。返回 'resume' | 'abort' | null，读完即清。
export function readManualSignal() {
  try {
    if (!fs.existsSync(recoverySignalFile)) return null;
    const value = fs.readFileSync(recoverySignalFile, 'utf8').trim().toLowerCase();
    fs.unlinkSync(recoverySignalFile);
    if (value === 'resume' || value === 'abort') return value;
    return null;
  } catch {
    return null;
  }
}

// 给外部（网页 / CLI / telegram-bot 的 /resume 处理）写信号用。
export function writeManualSignal(value) {
  if (value !== 'resume' && value !== 'abort') throw new Error('signal 只能是 resume / abort');
  fs.mkdirSync(path.dirname(recoverySignalFile), { recursive: true }); // 跨平台取上级目录(Windows 反斜杠也对)
  fs.writeFileSync(recoverySignalFile, value, { mode: 0o600 });
}
