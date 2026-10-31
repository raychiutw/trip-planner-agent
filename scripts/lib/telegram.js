'use strict';
/**
 * JS 端唯一的 Telegram 送出路徑（ops runtime module）。規則與 scripts/lib/send-telegram.sh 對齊：
 *   - token 格式 `<bot_id>:<secret>`、chat id 純數字（可負，群組），不合就不送（防 URL／body 注入）
 *   - env 優先序：TELEGRAM_BOT_HOME_TOKEN > TELEGRAM_BOT_TOKEN > TELEGRAM_BOT_FETCI_TOKEN
 *   - 永不丟例外（best-effort 通知不該讓呼叫端的主流程失敗），結果用回傳值表達
 *
 * 用法：const r = await sendTelegram(text, { parseMode: 'HTML' })  // env／fetchImpl 預設取 process.env／全域 fetch
 * 回傳 { ok: true } 或 { ok: false, reason: 'not-configured'|'bad-token'|'bad-chat'|`http-<status>`|'network' }
 */
const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;
const CHAT_RE = /^-?[0-9]+$/;

function resolveTelegramEnv(env) {
  const e = env || process.env;
  return {
    token: e.TELEGRAM_BOT_HOME_TOKEN || e.TELEGRAM_BOT_TOKEN || e.TELEGRAM_BOT_FETCI_TOKEN || '',
    chatId: e.TELEGRAM_CHAT_ID || '',
  };
}

async function sendTelegram(text, opts) {
  const o = opts || {};
  const { token, chatId } = resolveTelegramEnv(o.env);
  if (!token || !chatId) return { ok: false, reason: 'not-configured' };
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'bad-token' };
  if (!CHAT_RE.test(chatId)) return { ok: false, reason: 'bad-chat' };
  const body = { chat_id: chatId, text };
  if (o.parseMode) body.parse_mode = o.parseMode;
  try {
    const res = await (o.fetchImpl || fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `http-${res.status}` };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

module.exports = { sendTelegram, resolveTelegramEnv };
