/**
 * d1-client-script.test.ts — v2.33.49 round 8a critical test gap fill
 *
 * `scripts/lib/d1-client.js` 是 5 個 callers 共用的 D1 REST wrapper，
 * 之前的 result-shape bug (`results` vs `meta.changes`) 就是這個 helper
 * 存在的理由 — 但本身**零測試**。守住 SELECT / DELETE 路徑契約 + 錯誤路徑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.CLOUDFLARE_API_TOKEN = 'fake-token';
  process.env.CF_ACCOUNT_ID = 'fake-account';
  process.env.D1_DATABASE_ID = 'fake-db';
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CF_ACCOUNT_ID;
  delete process.env.D1_DATABASE_ID;
});

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('d1-client.js — getConfig env validation', () => {
  it('missing CLOUDFLARE_API_TOKEN → throws clear message', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await expect(queryD1('SELECT 1')).rejects.toThrow(/Missing.*CLOUDFLARE_API_TOKEN/);
  });

  it('missing CF_ACCOUNT_ID → throws', async () => {
    delete process.env.CF_ACCOUNT_ID;
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await expect(queryD1('SELECT 1')).rejects.toThrow(/Missing/);
  });

  it('missing D1_DATABASE_ID → throws', async () => {
    delete process.env.D1_DATABASE_ID;
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await expect(queryD1('SELECT 1')).rejects.toThrow(/Missing/);
  });
});

describe('d1-client.js — queryD1 (SELECT path)', () => {
  it('回傳 results array', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        success: true,
        result: [{ results: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }],
      }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    const rows = await queryD1('SELECT id, name FROM users');
    expect(rows).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  });

  it('空 results → 回空陣列 (不 throw)', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ results: [] }] }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    const rows = await queryD1('SELECT * FROM users WHERE 1=0');
    expect(rows).toEqual([]);
  });

  it('result undefined → 回空陣列 (defensive)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ success: true, result: undefined }));
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    const rows = await queryD1('SELECT 1');
    expect(rows).toEqual([]);
  });

  it('傳 params 進 fetch body', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ results: [] }] }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await queryD1('SELECT * FROM users WHERE id = ?', [42]);
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call?.[1] as { body: string }).body);
    expect(body).toEqual({ sql: 'SELECT * FROM users WHERE id = ?', params: [42] });
  });
});

describe('d1-client.js — execD1 (INSERT/UPDATE/DELETE path)', () => {
  it('回傳 meta.changes 數值', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ meta: { changes: 5 } }] }),
    );
    const { execD1 } = await import('../../scripts/lib/d1-client.js');
    const count = await execD1('DELETE FROM users WHERE created_at < ?', ['2020-01-01']);
    expect(count).toBe(5);
  });

  it('meta missing → 回 0 (defensive，例如 DDL CREATE TABLE)', async () => {
    fetchMock.mockResolvedValue(mockResponse({ success: true, result: [{}] }));
    const { execD1 } = await import('../../scripts/lib/d1-client.js');
    const count = await execD1('CREATE TABLE x (id INT)');
    expect(count).toBe(0);
  });

  it('meta.changes undefined → 回 0', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ meta: {} }] }),
    );
    const { execD1 } = await import('../../scripts/lib/d1-client.js');
    expect(await execD1('UPDATE x SET y = 1')).toBe(0);
  });
});

describe('d1-client.js — failure path', () => {
  it('success: false → throw with errors body', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        success: false,
        errors: [{ code: 7500, message: 'invalid SQL' }],
      }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await expect(queryD1('BAD SQL')).rejects.toThrow(/D1 query failed.*invalid SQL/);
  });

  it('Authorization Bearer header attach', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ results: [] }] }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await queryD1('SELECT 1');
    const call = fetchMock.mock.calls[0];
    const headers = (call?.[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer fake-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('URL contains account + DB id', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ success: true, result: [{ results: [] }] }),
    );
    const { queryD1 } = await import('../../scripts/lib/d1-client.js');
    await queryD1('SELECT 1');
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/accounts/fake-account/d1/database/fake-db/query');
  });
});

describe('d1-client.js — rawQuery (low-level access)', () => {
  it('回傳 result[0] 物件 (含 results + meta)', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        success: true,
        result: [{ results: [{ x: 1 }], meta: { changes: 0, duration: 0.5 } }],
      }),
    );
    const { rawQuery } = await import('../../scripts/lib/d1-client.js');
    const result = await rawQuery('SELECT x FROM t');
    expect(result).toEqual({ results: [{ x: 1 }], meta: { changes: 0, duration: 0.5 } });
  });
});
