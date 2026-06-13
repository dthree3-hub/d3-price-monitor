import {
  appendProduct,
  buildChangesMessage,
  buildHelpMessage,
  buildRunResultMessage,
  buildStatusMessage,
  buildWatchlistMessage,
  getTelegramUpdates,
  hasProductUrl,
  loadEnvFile,
  logHermes,
  readTelegramOffset,
  sendTelegramReply,
  telegramApi,
  writeTelegramOffset,
} from './lib-hermes.mjs';
import { runOnce } from './runOnce.mjs';
import { writeManualSignal } from './recovery/TelegramNotifier.mjs';
import { isPriceQuery, handlePriceQuery, isPriceLookupMiss, buildMarketContext } from './price-lookup.mjs';
import fs from 'node:fs';
import path from 'node:path';

// 单实例锁：out/telegram-bot.lock 存当前 PID，防止重复启动导致 getUpdates 409 Conflict
const LOCK_FILE = path.join(import.meta.dirname, '..', 'out', 'telegram-bot.lock');

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // 存在但无权限也算活着
  }
}

// 成功取锁返回 true；已有存活实例返回 false
function acquireSingleInstanceLock() {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
      const prev = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
      if (Number.isInteger(prev) && prev > 0 && prev !== process.pid && isPidAlive(prev)) {
        return false; // 另一个实例还活着
      }
      // 否则是陈旧锁（进程已死），覆盖即可
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (error) {
    logHermes(`单实例锁写入失败（放行）：${error.message || String(error)}`);
    return true;
  }

  const release = () => {
    try {
      if (fs.existsSync(LOCK_FILE)
        && Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch {
      // 释放失败忽略：下次启动会按 PID 存活判定为陈旧锁
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
  process.on('SIGTERM', () => { release(); process.exit(0); });
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

// 启动时从 getMe 填入，用于群组里识别 @ 提及
let BOT_USERNAME = '';

// 每个 chat 的最近对话上下文（内存态，重启清空），最多保留 10 条
const conversations = new Map();
const MAX_CONTEXT_MESSAGES = 10;

// 主人设由 .env 的 HERMES_PERSONA 控制（含「始终用英文回复」）；下面只是兜底默认值。
// 代码仅追加私聊/群组的上下文差异（私聊可称呼 Sarah；群组不称呼任何人）。
const DEFAULT_PERSONA = [
  'You are Hermes, a competitor-price analyst on the team for a Shopee Malaysia phone retailer (D3).',
  'ALWAYS reply in English, no matter what language the user writes in (Chinese, English, Malay, etc.).',
  'Talk like a sharp, friendly teammate — natural and concise, good for Telegram (usually 1-4 sentences).',
  'You are given a LIVE CONTEXT block below with real monitoring data (sweep status, recent changes, price competition). Answer from it directly and confidently. NEVER say you have no live data when context is provided.',
  'Only suggest a slash command (/run to scrape now, /status, /changes, /watchlist) when the user clearly wants an action you cannot perform yourself, or when you genuinely cannot understand them. Do NOT default to telling people to run commands.',
  'Never invent specific prices or numbers that are not in the context; if a specific figure is missing, say what you do know and offer to check.',
  'Never address anyone as "master", "boss", or any servile term.',
].join(' ');

function buildPersona(isGroup) {
  const base = (process.env.HERMES_PERSONA || '').trim() || DEFAULT_PERSONA;
  const context = isGroup
    ? 'This is a group chat: do not address anyone and do not use any personal name; stay neutral and to the point.'
    : 'This is a private 1:1 chat: you may naturally address the user as Sarah (no need to do so in every message).';
  return `${base} ${context}`;
}

function isGroupChat(message) {
  const type = message?.chat?.type;
  return type === 'group' || type === 'supergroup';
}

// 群组里只有 @ 了 bot、或回复 bot 的消息才响应；返回是否被点名 + 去掉 @ 后的文本
function resolveGroupMessage(message) {
  const text = message.text || '';
  let addressed = false;

  const replyUser = message.reply_to_message?.from?.username;
  if (replyUser && BOT_USERNAME && replyUser.toLowerCase() === BOT_USERNAME.toLowerCase()) {
    addressed = true;
  }

  if (BOT_USERNAME) {
    const mention = `@${BOT_USERNAME}`.toLowerCase();
    if (text.toLowerCase().includes(mention)) addressed = true;
  }

  const cleaned = BOT_USERNAME
    ? text.replace(new RegExp(`@${BOT_USERNAME}`, 'ig'), '').trim()
    : text.trim();

  return { addressed, text: cleaned };
}

function capLength(text, max = 1500) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

// 按已配置的 key 选择聊天用的 AI provider；AI_PROVIDER 可显式指定
function pickAiProvider() {
  const explicit = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const has = {
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  };
  if (explicit === 'claude') return has.anthropic ? 'anthropic' : null;
  if (explicit && has[explicit]) return explicit;
  if (has.deepseek) return 'deepseek';
  if (has.openai) return 'openai';
  if (has.anthropic) return 'anthropic';
  return null;
}

// DeepSeek 和 OpenAI 都是 OpenAI 兼容的 /chat/completions
async function callOpenAICompatible(provider, messages, system) {
  const isDeepSeek = provider === 'deepseek';
  const apiKey = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  const url = isDeepSeek
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = isDeepSeek
    ? process.env.DEEPSEEK_MODEL || 'deepseek-chat'
    : process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 600,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });

  if (!response.ok) {
    throw new Error(`${provider} ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || '';
}

// Anthropic Messages API（Opus 4.8：不传 temperature/top_p，否则 400）
async function callAnthropic(messages, system) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    throw new Error(`anthropic ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.content)
    ? payload.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : '';
}

// Take Back 业务知识（写进 system prompt，让 AI 能解释定义/公式；Hermes 不自己硬算）
// 公式与 Google Sheet「Samsung」tab 实际单元格公式一致（H列=Take back (S)）。
const BUSINESS_KNOWLEDGE = [
  'TAKE BACK — definition (use this when a user asks what take back is, how it is calculated, why it differs, or its formula):',
  'Take Back = the value in the Google Sheet column "Take back (S)". It is a trade-in / buy-back figure, NOT a price-drop action.',
  'Formula (matches the Sheet exactly, for EXPLANATION only): Take Back (S) = CSP − (CSP × Shopee Commission) − CCB − Ads Credit, where:',
  'CSP = Current Selling Price (Sheet column B).',
  'Shopee Commission = CSP × the per-model rate in Sheet column C — it VARIES by model (e.g. ~10.26% for A06 5G); it is NOT a fixed 5.5%.',
  'CCB (Coin Cashback) = the column the Sheet labels "CCB 5.5%", but its actual formula is CSP × 0.0594; the "7.5%" variant is CSP × 0.081.',
  'Ads Credit = the column labelled "Ads Credit 3%", but its actual formula is CSP × 0.0216 or CSP × 0.0324 depending on the model (per Sheet column G).',
  'Note: these effective rates look like the nominal rate plus 8% SST (e.g. 5.5% × 1.08 = 5.94% = 0.0594, 3% × 1.08 = 0.0324). So the header labels (5.5% / 7.5% / 3%) are nominal; the real deduction rates are the ×1.08 figures above.',
  'Worked example (A06 5G, verified against the Sheet): CSP = RM584, Commission rate = 0.1026, CCB = 584 × 0.0594 = RM34.69, Ads = 584 × 0.0216 = RM12.61 → Take Back = 584 − (584 × 0.1026) − 34.69 − 12.61 = RM476.78.',
  'IMPORTANT: the actual number Hermes shows is ALWAYS the Google Sheet column "Take back (S)" (read via /api/csp). Hermes only reads that final value — it never recomputes or overrides the Sheet result. Use the formula to explain the logic, not to produce the displayed figure.',
  'When a user asks for a specific model, e.g. "take back S26 256GB", that is a data lookup that returns the Sheet value; do not compute or guess a number.',
].join(' ');

// 给 AI 注入的实时上下文：sweep 状态 + 变价 + 价格竞争（都是现成数据，失败的部分跳过）
async function buildAiContext() {
  const parts = [];
  try { parts.push(`SWEEP STATUS:\n${buildStatusMessage()}`); } catch { /* 跳过 */ }
  try { parts.push(`RECENT CHANGES:\n${buildChangesMessage()}`); } catch { /* 跳过 */ }
  try { parts.push(`PRICE COMPETITION:\n${await buildMarketContext()}`); } catch { /* 跳过 */ }
  return parts.join('\n\n');
}

async function chatWithAI(chatId, userText, isGroup = false) {
  const provider = pickAiProvider();
  if (!provider) {
    // 仅在完全没配 AI key 时出现；配上 DEEPSEEK_API_KEY 即进入真正的 AI 助理模式
    return 'AI chat is not switched on yet (no DEEPSEEK_API_KEY set). Once it is, just ask me things like "which competitor is most aggressive" and I will answer from live data.';
  }

  const context = await buildAiContext();
  const base = `${buildPersona(isGroup)}\n\n${BUSINESS_KNOWLEDGE}`;
  const system = context
    ? `${base}\n\nLIVE CONTEXT (real data from the monitor, captured just now — use it, do not invent beyond it):\n${context}`
    : base;
  const history = conversations.get(chatId) || [];
  const messages = [...history, { role: 'user', content: userText }];

  try {
    let reply = provider === 'anthropic'
      ? await callAnthropic(messages, system)
      : await callOpenAICompatible(provider, messages, system);
    reply = capLength(String(reply || '').trim()) || '嗯，我在的，你想问什么？';

    // 记住最近 MAX_CONTEXT_MESSAGES 条上下文
    const next = [...messages, { role: 'assistant', content: reply }];
    conversations.set(chatId, next.slice(-MAX_CONTEXT_MESSAGES));
    return reply;
  } catch (error) {
    logHermes(`AI 聊天失败：${error.message || String(error)}`);
    console.error('AI 聊天失败：', error);
    return '抱歉，我刚走神了一下，你能再说一次吗？';
  }
}

function parseAddCommand(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/add\s+(.+?)\s+(https?:\/\/\S+)$/i);
  if (match) {
    return { competitor: match[1].trim(), product_url: match[2].trim() };
  }

  const urlMatch = raw.match(/https?:\/\/\S+/i);
  if (!urlMatch) return null;
  const productUrl = urlMatch[0].trim();
  const competitor = raw.replace(urlMatch[0], '').replace(/^\/?add\s+/i, '').trim();
  if (!competitor) return null;
  return { competitor, product_url: productUrl };
}

function buildExplainMessage(kind) {
  if (kind === 'status_help') {
    return 'status 是看系统运行状态的，例如上次什么时候跑过、成功抓了几个商品、发现几条变化、失败几条。';
  }
  if (kind === 'changes_help') {
    return 'changes 是看最近一次检测到的变价或库存变化，会列出哪个对手、哪个款式、涨了还是降了。';
  }
  if (kind === 'watchlist_help') {
    return 'watchlist 是看当前监控名单，也就是我现在会自动检查哪些 Shopee 商品。';
  }
  if (kind === 'run_help') {
    return 'run 是立刻手动跑一轮抓价，不用等每小时任务。跑完后 dashboard 和通知都会按结果更新。';
  }
  return buildHelpMessage();
}

async function executeAction(chatId, action, rawText, directReply = '') {
  if (!action || action === 'unknown') {
    return sendTelegramReply(chatId, directReply || buildHelpMessage());
  }

  if (action === 'help') {
    return sendTelegramReply(chatId, buildHelpMessage());
  }

  if (action === 'resume') {
    writeManualSignal('resume');
    return sendTelegramReply(chatId, '好,继续抓被拦的那一条。');
  }
  if (action === 'abort') {
    writeManualSignal('abort');
    return sendTelegramReply(chatId, '好,跳过被拦的那一条,继续往下。');
  }

  if (action === 'add') {
    const parsed = parseAddCommand(rawText);
    if (!parsed) {
      return sendTelegramReply(chatId, '你可以这样发给我：/add 对手名字 https://shopee.com.my/商品链接');
    }
    if (hasProductUrl(parsed.product_url)) {
      return sendTelegramReply(chatId, `这个商品已经在监控名单里了。\n${parsed.product_url}`);
    }
    appendProduct({
      competitor: parsed.competitor,
      product_url: parsed.product_url,
      status: 'active',
      keyword: parsed.competitor,
    });
    return sendTelegramReply(chatId, `已经帮你加入监控名单了。\n对手: ${parsed.competitor}\n链接: ${parsed.product_url}`);
  }

  if (action === 'status') {
    return sendTelegramReply(chatId, buildStatusMessage());
  }

  if (action === 'changes') {
    return sendTelegramReply(chatId, buildChangesMessage());
  }

  if (action === 'watchlist') {
    return sendTelegramReply(chatId, buildWatchlistMessage());
  }

  if (action === 'run') {
    await sendTelegramReply(chatId, '我现在开始检查，请稍等。');
    try {
      const result = await runOnce();
      return sendTelegramReply(chatId, buildRunResultMessage(result));
    } catch (error) {
      return sendTelegramReply(chatId, `这轮检查失败了：${error.message || String(error)}`);
    }
  }

  if (action.endsWith('_help')) {
    return sendTelegramReply(chatId, buildExplainMessage(action));
  }

  if (action === 'reply') {
    return sendTelegramReply(chatId, directReply || buildHelpMessage());
  }

  return sendTelegramReply(
    chatId,
    directReply || buildHelpMessage()
  );
}

// 收紧路由：只有斜杠命令 / 近乎纯关键词 / 明确动作(run、加链接) 才走命令；
// 自然语言问题一律落到 AI Chat Mode（带实时上下文）。避免 "价格/status/检查" 等词被贪婪截走。
function classifyByRules(text) {
  const normalized = normalizeText(text);
  if (!normalized) return { action: 'unknown' };

  // 命令含义解释（先于纯关键词，"status什么意思" 不应被当 /status）
  if (normalized.includes('status') && (normalized.includes('什么意思') || normalized.includes('meaning'))) return { action: 'status_help' };
  if (normalized.includes('changes') && normalized.includes('什么意思')) return { action: 'changes_help' };
  if (normalized.includes('watchlist') && normalized.includes('什么意思')) return { action: 'watchlist_help' };
  if (normalized.includes('run') && normalized.includes('什么意思')) return { action: 'run_help' };

  if (normalized === '/start' || normalized === '/help' || normalized === 'help' || normalized === '帮助') return { action: 'help' };
  if (normalized === '/resume' || normalized === 'resume' || normalized === '继续') return { action: 'resume' };
  if (normalized === '/abort' || normalized === 'abort' || normalized === '跳过') return { action: 'abort' };

  // 动作：新增监控（带链接才算）
  if (normalized.startsWith('/add') || (normalized.includes('add') && normalized.includes('http'))) return { action: 'add' };

  // 斜杠命令 / 近乎纯关键词（精确匹配，自然语言不再误触）
  if (normalized === '/status' || normalized === 'status' || normalized === '状态') return { action: 'status' };
  if (normalized === '/changes' || normalized === 'changes' || normalized === '变价') return { action: 'changes' };
  if (normalized === '/watchlist' || normalized === 'watchlist' || normalized === '监控名单' || normalized === '名单') return { action: 'watchlist' };

  // 动作：立即抓取（斜杠或明确祈使句）
  if (normalized === '/run' || normalized === 'run' || /^(跑一轮|跑价|跑一下|立即(检查|抓)|现在(抓|跑|检查)一?(轮|下)?|run\s*now)$/.test(normalized)) {
    return { action: 'run' };
  }

  return { action: 'unknown' };
}

async function handleText(chatId, text, isGroup = false) {
  // 价格查询：先于命令与 AI。数字只来自 /api/records。
  if (isPriceQuery(text)) {
    const reply = await handlePriceQuery(text);
    if (!isPriceLookupMiss(reply)) return sendTelegramReply(chatId, reply);
    // 0 命中（解析不到型号）→ 不直接死掉，直接 fallback 到 AI（可解释找不到 / 回答公式 / 多型号）。
    const aiReply = await chatWithAI(chatId, text, isGroup);
    return sendTelegramReply(chatId, aiReply);
  }

  // 模式 1：命令（含中英文关键词）——保持原有功能不变
  const ruleIntent = classifyByRules(text);
  if (ruleIntent.action !== 'unknown') {
    return executeAction(chatId, ruleIntent.action, text, ruleIntent.reply || '');
  }

  // 模式 2：非命令 → 自然语言聊天，交给 AI 生成回复（群组人设不称呼任何人）
  const reply = await chatWithAI(chatId, text, isGroup);
  return sendTelegramReply(chatId, reply);
}

async function pollLoop() {
  loadEnvFile();
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    const message = 'Telegram bot 未启动：缺少 TELEGRAM_BOT_TOKEN';
    console.error(message);
    logHermes(message);
    process.exit(2); // 配置缺失：bat 不应重启
  }
  if (!acquireSingleInstanceLock()) {
    const message = '检测到已有 Telegram bot 实例在运行（单实例锁），本次退出，避免 409 Conflict。';
    console.error(message);
    logHermes(message);
    process.exit(3); // 已有实例：bat 不应重启
  }
  let offset = readTelegramOffset();

  // 取 bot 用户名，群组里用来识别 @ 提及
  try {
    const me = await telegramApi('getMe');
    BOT_USERNAME = me?.result?.username || '';
  } catch (error) {
    logHermes(`getMe 失败（不影响私聊）：${error.message || String(error)}`);
  }

  logHermes('Telegram bot 启动');
  console.log(`Telegram bot 已启动${BOT_USERNAME ? `（@${BOT_USERNAME}）` : ''}`);

  while (true) {
    try {
      const response = await getTelegramUpdates(offset + 1, 20);
      const updates = Array.isArray(response.result) ? response.result : [];
      for (const update of updates) {
        offset = update.update_id;
        writeTelegramOffset(offset);

        const message = update.message;
        if (!message?.chat?.id) continue;

        // 私聊：命令 + 自然语言都响应；群组：只响应 @ 了 bot（或回复 bot）的消息
        if (isGroupChat(message)) {
          const { addressed, text } = resolveGroupMessage(message);
          if (!addressed) continue;
          await handleText(message.chat.id, text, true);
        } else {
          await handleText(message.chat.id, message.text || '', false);
        }
      }
    } catch (error) {
      const message = `Telegram bot 轮询失败：${error.message || String(error)}`;
      console.error(message);
      logHermes(message);
      await sleep(5000);
    }
  }
}

pollLoop().catch((error) => {
  console.error(`Telegram bot 启动失败：${error.message || String(error)}`);
  process.exit(1);
});
