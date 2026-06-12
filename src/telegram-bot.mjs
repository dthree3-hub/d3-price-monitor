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
  writeTelegramOffset,
} from './lib-hermes.mjs';
import { runOnce } from './runOnce.mjs';
import { writeManualSignal } from './recovery/TelegramNotifier.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

function hasDeepSeekConfig() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
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

function normalizeAction(action) {
  const value = String(action || '').trim().toLowerCase();
  const alias = {
    check: 'run',
    run_now: 'run',
    run_check: 'run',
    price_check: 'run',
    latest_changes: 'changes',
    change: 'changes',
    recent_changes: 'changes',
    list: 'watchlist',
    monitored: 'watchlist',
    explain_status: 'status_help',
    explain_changes: 'changes_help',
    explain_watchlist: 'watchlist_help',
    explain_run: 'run_help',
    faq_status: 'status_help',
    faq_changes: 'changes_help',
    faq_watchlist: 'watchlist_help',
    faq_run: 'run_help',
  };
  return alias[value] || value;
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

async function classifyWithDeepSeek(text) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            '你是 Hermes，一位给 Sarah 使用的 Shopee 价格监控助理。',
            '你的语气要像简洁的个人秘书，直接、自然、少废话，不要像机器人菜单。',
            '你负责先理解用户的人话，再把它映射成受限动作，不能编造系统状态。',
            '允许动作：status, changes, watchlist, run, add, help, status_help, changes_help, watchlist_help, run_help, reply, unknown。',
            '当用户是想新增监控商品时，用 add；当用户是在问命令是什么意思时，用对应 *_help。',
            '如果用户只是闲聊或问不在系统能力范围内的事，用 reply，并用助理口吻简短回答，再轻轻引导到你能做的事。',
            '如果用户问“你现在在做什么”“你可以做什么”“我的S26价格是多少”这类问题，优先给自然回答，不要上来就贴命令菜单。',
            '如果用户问单个型号当前价格，但系统里没有单独查询动作，就用 reply 简短说明你目前能查最近变价、监控名单或立刻跑检查。',
            '必须返回 JSON：{"action":"...", "reply":"...", "competitor":"", "product_url":""}。',
            '只有 action=add 时才填写 competitor 和 product_url。',
          ].join(' '),
        },
        {
          role: 'user',
          content: text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${body}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) return null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  return {
    action: normalizeAction(parsed.action),
    reply: String(parsed.reply || '').trim(),
    competitor: String(parsed.competitor || '').trim(),
    product_url: String(parsed.product_url || '').trim(),
  };
}

function classifyByRules(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized === '/start' || normalized === '/help' || normalized === 'help') {
    return { action: 'help' };
  }

  if (normalized === '/resume' || normalized === 'resume' || normalized === '继续') {
    return { action: 'resume' };
  }
  if (normalized === '/abort' || normalized === 'abort' || normalized === '跳过') {
    return { action: 'abort' };
  }

  if (normalized.startsWith('/add') || (normalized.includes('add') && normalized.includes('http'))) {
    return { action: 'add' };
  }

  if (normalized === '/status' || normalized.includes('status') || normalized.includes('状态')) {
    return { action: 'status' };
  }

  if (
    normalized.includes('status什么意思') ||
    normalized.includes('status 是什么意思') ||
    normalized.includes('status meaning')
  ) {
    return { action: 'status_help' };
  }

  if (normalized === '/changes' || normalized.includes('change') || normalized.includes('变价') || normalized.includes('价格')) {
    return { action: 'changes' };
  }

  if (normalized.includes('changes什么意思') || normalized.includes('changes 是什么意思')) {
    return { action: 'changes_help' };
  }

  if (normalized === '/watchlist' || normalized.includes('watchlist') || normalized.includes('监控') || normalized.includes('名单')) {
    return { action: 'watchlist' };
  }

  if (normalized.includes('watchlist什么意思') || normalized.includes('watchlist 是什么意思')) {
    return { action: 'watchlist_help' };
  }

  if (normalized === '/run' || normalized.includes('run') || normalized.includes('检查') || normalized.includes('现在抓')) {
    return { action: 'run' };
  }

  if (normalized.includes('run什么意思') || normalized.includes('run 是什么意思')) {
    return { action: 'run_help' };
  }

  return { action: 'unknown' };
}

async function handleText(chatId, text) {
  const ruleIntent = classifyByRules(text);
  if (ruleIntent.action !== 'unknown') {
    return executeAction(chatId, ruleIntent.action, text, ruleIntent.reply || '');
  }

  if (hasDeepSeekConfig()) {
    try {
      const aiIntent = await classifyWithDeepSeek(text);
      if (aiIntent?.action === 'add' && aiIntent.product_url && aiIntent.competitor) {
        return executeAction(
          chatId,
          'add',
          `/add ${aiIntent.competitor} ${aiIntent.product_url}`,
          aiIntent.reply || ''
        );
      }
      if (aiIntent?.action) {
        return executeAction(chatId, aiIntent.action, text, aiIntent.reply || '');
      }
    } catch (error) {
      const message = `DeepSeek 意图识别失败：${error.message || String(error)}`;
      console.error(message);
      logHermes(message);
    }
  }

  return executeAction(chatId, 'unknown', text, '');
}

async function pollLoop() {
  loadEnvFile();
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    const message = 'Telegram bot 未启动：缺少 TELEGRAM_BOT_TOKEN';
    console.error(message);
    logHermes(message);
    return;
  }
  let offset = readTelegramOffset();
  logHermes('Telegram bot 启动');
  console.log('Telegram bot 已启动');

  while (true) {
    try {
      const response = await getTelegramUpdates(offset + 1, 20);
      const updates = Array.isArray(response.result) ? response.result : [];
      for (const update of updates) {
        offset = update.update_id;
        writeTelegramOffset(offset);

        const message = update.message;
        if (!message?.chat?.id) continue;
        await handleText(message.chat.id, message.text || '');
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
