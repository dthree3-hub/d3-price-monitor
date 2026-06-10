// SessionManager — 安全地存/取/还原浏览器会话。
//
// 存两份：
//   out/shopee-state.json   — Playwright storageState 格式（cookies + origins.localStorage），
//                             现有 scraper.mjs 直接能复用，下次启动免再登录。
//   out/recovery/session.json — 全量（额外含 sessionStorage + 元信息），给恢复流程用。
//
// 安全：
//   - 只存会话 cookie / storage，绝不存账号密码（明文凭据零落地）。
//   - cookie 默认只保留目标站点（shopee）域，缩小敏感面。
//   - 文件 chmod 600，原子写。
//   - 日志只打计数（summarize），绝不打 value。
//   - out/ 已在 .gitignore，会话文件不会进 git。

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../lib-records.mjs';
import { recoveryDir } from './events.mjs';

export const storageStateFile = path.join(projectRoot, 'out', 'shopee-state.json');
export const recoverySessionFile = path.join(recoveryDir, 'session.json');

// 默认只保留这些域的 cookie（关键词匹配 domain）。可用环境变量覆盖。
function cookieDomainAllowList() {
  const raw = process.env.HERMES_SESSION_COOKIE_DOMAINS || 'shopee';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function cookieAllowed(cookie) {
  const allow = cookieDomainAllowList();
  if (!allow.length) return true;
  const domain = String(cookie?.domain || '').toLowerCase();
  return allow.some((needle) => domain.includes(needle));
}

// 原子写 + chmod 600。
function writeSecret(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持 */ }
}

// CDP 的 sameSite 取值 -> Playwright 取值。
function normalizeSameSite(value) {
  if (value === 'Strict' || value === 'Lax' || value === 'None') return value;
  return 'Lax';
}

// 在页面里 dump localStorage / sessionStorage 的表达式（只读）。
export function buildStorageDumpExpression() {
  return String.raw`
    (() => {
      const dump = (store) => {
        const out = [];
        try {
          for (let i = 0; i < store.length; i += 1) {
            const k = store.key(i);
            out.push({ name: k, value: store.getItem(k) });
          }
        } catch (e) { /* 跨域或被禁用时忽略 */ }
        return out;
      };
      return {
        origin: location.origin,
        localStorage: dump(window.localStorage),
        sessionStorage: dump(window.sessionStorage),
      };
    })()
  `;
}

// 从 CDP 读出整个会话，组装成 storageState 兼容结构 + sessionStorage 旁路。
// 需要 Network、Runtime 域已 enable。
export async function captureViaCDP({ Network, Runtime }) {
  const all = await Network.getAllCookies().catch(() => ({ cookies: [] }));
  const cookies = (all.cookies || [])
    .filter(cookieAllowed)
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: normalizeSameSite(c.sameSite),
    }));

  let storage = { origin: '', localStorage: [], sessionStorage: [] };
  try {
    const res = await Runtime.evaluate({
      expression: buildStorageDumpExpression(),
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.result?.value) storage = res.result.value;
  } catch { /* 读不到就留空 */ }

  return {
    cookies,
    origins: storage.origin
      ? [{ origin: storage.origin, localStorage: storage.localStorage || [] }]
      : [],
    sessionStorage: storage.sessionStorage || [],
    capturedAt: new Date().toISOString(),
    origin: storage.origin || '',
  };
}

// 写盘：storageState 一份（兼容现有 scraper），全量一份（含 sessionStorage）。
export function save(session, { stateFile = storageStateFile, fullFile = recoverySessionFile } = {}) {
  const storageState = {
    cookies: session.cookies || [],
    origins: session.origins || [],
  };
  writeSecret(stateFile, `${JSON.stringify(storageState, null, 2)}\n`);
  writeSecret(fullFile, `${JSON.stringify(session, null, 2)}\n`);
  return summarize(session);
}

export function load({ fullFile = recoverySessionFile, stateFile = storageStateFile } = {}) {
  const file = fs.existsSync(fullFile) ? fullFile : (fs.existsSync(stateFile) ? stateFile : null);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 把已存会话灌回一个新标签页（供「未来运行复用已验证会话」）。最大努力，失败不抛。
export async function restoreViaCDP({ Network, Runtime }, session = load()) {
  if (!session) return { restored: false, reason: 'no-session' };
  try {
    if (session.cookies?.length) {
      await Network.setCookies({ cookies: session.cookies }).catch(() => {});
    }
    const ls = session.origins?.[0]?.localStorage || [];
    const ss = session.sessionStorage || [];
    if (ls.length || ss.length) {
      await Runtime.evaluate({
        expression: buildStorageRestoreExpression(ls, ss),
        awaitPromise: true,
        returnByValue: true,
      }).catch(() => {});
    }
    return { restored: true, ...summarize(session) };
  } catch (error) {
    return { restored: false, reason: error?.message || String(error) };
  }
}

function buildStorageRestoreExpression(localItems, sessionItems) {
  const local = JSON.stringify(localItems || []);
  const sess = JSON.stringify(sessionItems || []);
  return String.raw`
    (() => {
      try {
        for (const { name, value } of ${local}) window.localStorage.setItem(name, value);
      } catch (e) {}
      try {
        for (const { name, value } of ${sess}) window.sessionStorage.setItem(name, value);
      } catch (e) {}
      return true;
    })()
  `;
}

// 只返回计数 / 域名，绝不含任何 value —— 这是唯一允许进日志的会话信息。
export function summarize(session) {
  if (!session) return { cookieCount: 0, localStorageKeys: 0, sessionStorageKeys: 0, origins: [] };
  return {
    cookieCount: (session.cookies || []).length,
    localStorageKeys: (session.origins?.[0]?.localStorage || []).length,
    sessionStorageKeys: (session.sessionStorage || []).length,
    origins: (session.origins || []).map((o) => o.origin),
  };
}
