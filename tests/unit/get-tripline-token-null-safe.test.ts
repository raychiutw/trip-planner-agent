import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// 行為測試（source-grep 的補強）— 2026-07-13 事故：prod /api/oauth/token 短暫回
// 「非-2xx + 字面 null body」，舊 `const json = await res.json()` 讓 json=null，
// 錯誤處理在 json.error 上爆 "null is not an object"，蓋掉 HTTP status。這裡直接
// mock fetch 跑三種 failure mode，鎖住「行為」而非只鎖「原始碼字串」。
const require = createRequire(import.meta.url);
const { getToken, invalidateCache } = require('../../scripts/lib/get-tripline-token.js');

describe('get-tripline-token fetchFresh null-safe（2026-07-13 事故）', () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    process.env.TRIPLINE_API_CLIENT_ID = 'test-id';
    process.env.TRIPLINE_API_CLIENT_SECRET = 'test-secret';
    invalidateCache();
  });
  afterEach(() => {
    global.fetch = origFetch;
    invalidateCache();
  });

  const mockFetch = (r: unknown) => {
    global.fetch = (async () => r) as unknown as typeof fetch;
  };

  it('503 + 字面 null body → 乾淨的 (503) 錯誤（事故情境）', async () => {
    mockFetch({ ok: false, status: 503, json: async () => null });
    await expect(getToken({ forceFresh: true })).rejects.toThrow(/Token fetch failed \(503\)/);
  });

  it('503 + 字面 null body → 錯誤訊息不含 "is not an object"（就是舊 bug 的證據）', async () => {
    mockFetch({ ok: false, status: 502, json: async () => null });
    await expect(getToken({ forceFresh: true })).rejects.not.toThrow(/is not an object/);
  });

  it('非-JSON body（res.json throw）→ 一樣乾淨收斂成 (status) 錯誤', async () => {
    mockFetch({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    await expect(getToken({ forceFresh: true })).rejects.toThrow(/Token fetch failed \(502\)/);
  });

  it('非-2xx + 有 error body → 訊息保留 status + OAuth error 診斷（修復的核心價值）', async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'bad secret' }) });
    await expect(getToken({ forceFresh: true })).rejects.toThrow(/Token fetch failed \(401\): invalid_client bad secret/);
  });

  it('200 但 access_token 非字串（{}）→ 拒發，不回 Bearer [object Object]', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ access_token: {} }) });
    await expect(getToken({ forceFresh: true })).rejects.toThrow();
  });

  it('200 + 合法字串 token → 正常回傳', async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ access_token: 'tok_abc', expires_in: 3600 }) });
    await expect(getToken({ forceFresh: true })).resolves.toBe('tok_abc');
  });
});
