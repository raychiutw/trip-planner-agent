/**
 * ops runtime：JS 端唯一的 Telegram 送出路徑（scripts/lib/telegram.js 的 sendTelegram）。
 *
 * 之前 daily-report.js 與 _lib/cron-shared.ts 各寫一份：前者不驗 token 格式、不驗 chat id、
 * 不看 HTTP 狀態就印「alert sent」；後者驗 token 但 env 優先序和前者相反。
 * 統一後規則與 scripts/lib/send-telegram.sh 對齊（token 格式、chat id 純數字）。
 * 全部以注入的 fetch 驗證，不碰網路。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const { sendTelegram, resolveTelegramEnv } = createRequire(import.meta.url)(join(__dirname, '../../scripts/lib/telegram.js'));

const TOKEN = '123456:ABC-def_ghi';
const ok = () => Promise.resolve({ ok: true, status: 200 });

describe('resolveTelegramEnv', () => {
  it('token 優先序：HOME > BOT > FETCI', () => {
    expect(resolveTelegramEnv({ TELEGRAM_BOT_TOKEN: '1:b', TELEGRAM_BOT_HOME_TOKEN: '1:h', TELEGRAM_BOT_FETCI_TOKEN: '1:f', TELEGRAM_CHAT_ID: '5' }).token).toBe('1:h');
    expect(resolveTelegramEnv({ TELEGRAM_BOT_TOKEN: '1:b', TELEGRAM_BOT_FETCI_TOKEN: '1:f', TELEGRAM_CHAT_ID: '5' }).token).toBe('1:b');
    expect(resolveTelegramEnv({ TELEGRAM_BOT_FETCI_TOKEN: '1:f', TELEGRAM_CHAT_ID: '5' }).token).toBe('1:f');
  });
});

describe('sendTelegram', () => {
  it('env 沒設 → not-configured，不呼叫 fetch', async () => {
    const fetchImpl = vi.fn(ok);
    expect(await sendTelegram('hi', { env: {}, fetchImpl })).toEqual({ ok: false, reason: 'not-configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('token 格式不合法 → bad-token，不呼叫 fetch（防注入 URL）', async () => {
    const fetchImpl = vi.fn(ok);
    const r = await sendTelegram('hi', { env: { TELEGRAM_BOT_TOKEN: '123:abc/../x?y=1', TELEGRAM_CHAT_ID: '5' }, fetchImpl });
    expect(r).toEqual({ ok: false, reason: 'bad-token' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('chat id 非純數字 → bad-chat，不呼叫 fetch', async () => {
    const fetchImpl = vi.fn(ok);
    const r = await sendTelegram('hi', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "5'; drop" }, fetchImpl });
    expect(r).toEqual({ ok: false, reason: 'bad-chat' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('負數 chat id（群組）合法；成功時 POST 到正確 URL 與 body', async () => {
    const fetchImpl = vi.fn(ok);
    const r = await sendTelegram('哈囉', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100123' }, fetchImpl });
    expect(r).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '-100123', text: '哈囉' });
  });

  it('parseMode 只有明確傳入才帶', async () => {
    const fetchImpl = vi.fn(ok);
    await sendTelegram('x', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '5' }, fetchImpl, parseMode: 'HTML' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).parse_mode).toBe('HTML');
  });

  it('HTTP 非 2xx → ok:false（不再謊稱 sent）', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 401 }));
    expect(await sendTelegram('x', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '5' }, fetchImpl })).toEqual({ ok: false, reason: 'http-401' });
  });

  it('fetch 丟錯 → ok:false network，不往外丟', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('boom')));
    expect(await sendTelegram('x', { env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '5' }, fetchImpl })).toEqual({ ok: false, reason: 'network' });
  });
});

describe('結構：JS 端只有 lib/telegram.js 會打 Telegram API', () => {
  const ROOT = join(__dirname, '../..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); }
      else if (/\.(js|mjs|ts)$/.test(name)) out.push(p);
    }
    return out;
  }
  it('scripts/ 內其他 js／ts 不得直接呼叫 api.telegram.org', () => {
    const offenders = walk(join(ROOT, 'scripts'))
      .filter((p) => !p.endsWith('scripts/lib/telegram.js'))
      .filter((p) => readFileSync(p, 'utf8').includes('api.telegram.org'))
      .map((p) => p.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
