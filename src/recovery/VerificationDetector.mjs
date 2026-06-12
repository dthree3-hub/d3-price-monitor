// VerificationDetector — 判断当前页面是不是拦路页，以及是哪一类。
// 不做任何「破解 / 绕过」，只识别状态，交给人去处理。
//
// 两个入口：
//   buildDetectionExpression() -> 一段在页面上下文里跑的 JS（给 CDP Runtime.evaluate）
//   detectFromSnapshot(snapshot) -> 纯函数分类（方便单测）
//   detectViaCDP({ Runtime }) -> 在真实 Chrome 标签页里读一次并分类
//   classifyError(error) -> 把 scraper 已有的报错（登录页 / 反爬码）映射成类型

import { VERIFICATION_TYPES } from './events.mjs';

// 在页面里执行：收集各种信号，返回可序列化对象。只读，不点任何东西。
export function buildDetectionExpression() {
  return String.raw`
    (() => {
      const url = location.href;
      const title = document.title || '';
      const bodyText = ((document.body && document.body.innerText) || '').slice(0, 6000);
      const html = ((document.documentElement && document.documentElement.outerHTML) || '').slice(0, 20000);
      const has = (sel) => { try { return !!document.querySelector(sel); } catch (e) { return false; } };
      const t = bodyText;

      const signals = {
        // Cloudflare 质询页（"Just a moment..." / Turnstile / cf-chl）
        cfTitle: /just a moment|checking your browser|attention required/i.test(title),
        cfChallenge: has('#challenge-form') || has('#cf-challenge-running') || /cf-chl|__cf_chl|cf-turnstile|challenges\.cloudflare\.com/i.test(html),
        cfRay: /cloudflare/i.test(html) && /ray id/i.test(t),

        // 各类验证码（reCAPTCHA / hCaptcha / Turnstile / Shopee 自家滑块）
        recaptcha: has('iframe[src*="recaptcha"]') || has('.g-recaptcha'),
        hcaptcha: has('iframe[src*="hcaptcha"]') || has('.h-captcha'),
        turnstile: has('iframe[src*="challenges.cloudflare.com"]') || has('.cf-turnstile'),
        captchaText: /captcha|verify (you are|that you are)(\s+a)?\s+human|slide to verify|drag the slider|拖动滑块|完成验证|安全验证|人机/i.test(t),
        shopeeVerify: /\/verify(\/|\b)|\/captcha/i.test(url) || /unusual traffic|please verify|verify to continue/i.test(t),

        // 需要登录
        loginUrl: /\/login\b|\/buyer\/login|sign[_-]?in/i.test(url),
        loginText: (/log\s*in|sign in|请登录|登入|立即登录/i.test(t) && (has('input[type="password"]') || /\/login/i.test(url))),
        passwordField: has('input[type="password"]'),

        // 访问被拒 / 被封 / 账号因自动化被限制（Shopee "Page Unavailable" 封锁页）
        denied: /access denied|403 forbidden|forbidden|you don'?t have permission|have been blocked|ip address.*blocked|too many requests|429|account has been (temporarily )?restricted|automated tools? detected|permanent ban|page unavailable/i.test(t)
          || /403|access denied|page unavailable/i.test(title),

        // 会话过期
        sessionExpired: /session (has )?expired|please log ?in again|登录已过期|登入已过期|重新登录|your session (has )?timed out|session timeout/i.test(t),
      };

      return { url, title, readyState: document.readyState || '', signals };
    })()
  `;
}

// 纯函数：根据信号分类。优先级：验证码 > Cloudflare > 会话过期 > 需登录 > 被拒。
export function detectFromSnapshot(snapshot) {
  const url = snapshot?.url || '';
  const title = snapshot?.title || '';
  const sig = snapshot?.signals || {};
  const reasons = [];
  const mark = (cond, label) => { if (cond) reasons.push(label); return cond; };

  const isCaptcha =
    mark(sig.recaptcha, 'recaptcha') |
    mark(sig.hcaptcha, 'hcaptcha') |
    mark(sig.turnstile, 'turnstile') |
    mark(sig.captchaText, 'captcha-text') |
    mark(sig.shopeeVerify, 'shopee-verify');

  const isCloudflare =
    mark(sig.cfTitle, 'cf-title') |
    mark(sig.cfChallenge, 'cf-challenge') |
    mark(sig.cfRay, 'cf-ray');

  const isSessionExpired = mark(sig.sessionExpired, 'session-expired');
  const isLogin = mark(sig.loginUrl, 'login-url') | mark(sig.loginText, 'login-text');
  const isDenied = mark(sig.denied, 'access-denied');

  let type = VERIFICATION_TYPES.NONE;
  if (isCaptcha) type = VERIFICATION_TYPES.CAPTCHA;
  else if (isCloudflare) type = VERIFICATION_TYPES.CLOUDFLARE;
  else if (isSessionExpired) type = VERIFICATION_TYPES.SESSION_EXPIRED;
  else if (isLogin) type = VERIFICATION_TYPES.LOGIN_REQUIRED;
  else if (isDenied) type = VERIFICATION_TYPES.ACCESS_DENIED;

  return {
    blocked: type !== VERIFICATION_TYPES.NONE,
    type,
    title,
    url,
    reasons,
  };
}

// 在真实 Chrome 标签里读一次状态并分类。需要 CDP 的 Runtime 域已 enable。
export async function detectViaCDP({ Runtime }) {
  const res = await Runtime.evaluate({
    expression: buildDetectionExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  const snapshot = res?.result?.value;
  if (!snapshot) {
    return { blocked: false, type: VERIFICATION_TYPES.NONE, title: '', url: '', reasons: ['no-snapshot'] };
  }
  return detectFromSnapshot(snapshot);
}

// 把 scraper.mjs 已有的中文报错映射成验证类型，让抛错也能触发恢复流程。
export function classifyError(error) {
  const text = String(error?.message || error || '');
  // Shopee 反爬软拦截码(90309999 等)→ 走人工兜底:让人去过验证,再续抓
  if (/90309999|被反爬|反爬|unusual traffic|anti.?bot/i.test(text)) return VERIFICATION_TYPES.ANTI_BOT;
  if (/登录页|登入页|need.*log ?in|login page/i.test(text)) return VERIFICATION_TYPES.LOGIN_REQUIRED;
  if (/captcha|验证码|滑块|人机/i.test(text)) return VERIFICATION_TYPES.CAPTCHA;
  if (/cloudflare|just a moment/i.test(text)) return VERIFICATION_TYPES.CLOUDFLARE;
  if (/access denied|forbidden|被封|blocked|403|account.*restricted|automated tools? detected|permanent ban|page unavailable/i.test(text)) return VERIFICATION_TYPES.ACCESS_DENIED;
  if (/session.*expired|登录已过期|重新登录|掉登录态/i.test(text)) return VERIFICATION_TYPES.SESSION_EXPIRED;
  return VERIFICATION_TYPES.NONE;
}
