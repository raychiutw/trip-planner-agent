/**
 * cron-shared.alertTelegram：薄包裝，送出規則在 scripts/lib/telegram.js（見 telegram-send.test.ts）。
 * 這裡只驗它自己的行為：設定缺失／格式錯誤「只警告一次」、不丟例外、吃 HOME token 優先。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['TELEGRAM_BOT_HOME_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_FETCI_TOKEN', 'TELEGRAM_CHAT_ID'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();   // _telegramWarned 是模組級狀態，每個案例要全新的模組
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('alertTelegram', () => {
  it('缺設定 → 只警告一次、不呼叫 fetch、不丟錯', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    await alertTelegram('a');
    await alertTelegram('b');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('token 格式不合法 → 不送出（防注入），且只警告一次', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bad/../token';
    process.env.TELEGRAM_CHAT_ID = '5';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    await alertTelegram('a');
    await alertTelegram('b');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('HOME token 優先於 BOT token，POST 到該 token 的 URL', async () => {
    process.env.TELEGRAM_BOT_HOME_TOKEN = '111:home';
    process.env.TELEGRAM_BOT_TOKEN = '222:bot';
    process.env.TELEGRAM_CHAT_ID = '5';
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    await alertTelegram('hello');
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://api.telegram.org/bot111:home/sendMessage');
  });

  it('chat id 不合法 → 不送出、警告一次', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '111:abc';
    process.env.TELEGRAM_CHAT_ID = '@channel';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    await alertTelegram('a');
    await alertTelegram('b');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('送出失敗（HTTP 非 2xx／網路錯誤）→ 不丟錯、不洗版警告（best-effort，與舊行為相同）', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '111:abc';
    process.env.TELEGRAM_CHAT_ID = '5';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    await expect(alertTelegram('a')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await expect(alertTelegram('b')).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('不同設定問題各警告一次（token 壞、chat 壞不共用同一個 dedupe 旗標）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn());
    const { alertTelegram } = await import('../../scripts/_lib/cron-shared');
    await alertTelegram('x');                       // not-configured
    process.env.TELEGRAM_BOT_TOKEN = 'bad/../token';
    process.env.TELEGRAM_CHAT_ID = '5';
    await alertTelegram('x');                       // bad-token
    process.env.TELEGRAM_BOT_TOKEN = '111:abc';
    process.env.TELEGRAM_CHAT_ID = '@channel';
    await alertTelegram('x');                       // bad-chat
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
