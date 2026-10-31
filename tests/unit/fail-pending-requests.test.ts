/**
 * ADR-0007 第一層收屍 — scripts/lib/fail-pending-requests.ts
 *
 * api-server 確定「不會再有人處理」時（reaper 收尾、tmux 起不來、REPL 未就緒、
 * skill 未提交）就地把該 trip 還在跑的 request 標終結，不用等 100 分鐘牆鐘。
 *
 * 最重要的守衛是**只殺列表回報還在跑的那些** —— PATCH status='failed' 從任何狀態
 * 都合法（failed 例外），無條件打會把剛完成的 request 一起清掉。
 */
import { describe, it, expect, vi } from 'vitest';
import { failPendingRequests, type FailPendingDeps } from '../../scripts/lib/fail-pending-requests';

interface Call { url: string; init?: RequestInit }

function makeDeps(
  listBy: Record<string, Array<{ id: number }>>,
  opts: { listOk?: boolean; listBody?: unknown; patchOk?: boolean } = {},
): { deps: FailPendingDeps; calls: Call[]; errors: string[] } {
  const calls: Call[] = [];
  const errors: string[] = [];
  const deps: FailPendingDeps = {
    apiBase: 'https://api.test',
    getToken: async () => 'svc-token',
    log: () => {},
    logError: (m: string) => { errors.push(m); },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'PATCH') {
        return { ok: opts.patchOk ?? true, status: opts.patchOk === false ? 500 : 200 };
      }
      if (opts.listOk === false) return { ok: false, status: 503, json: async () => null };
      const status = new URL(url).searchParams.get('status') ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => (opts.listBody !== undefined ? opts.listBody : { items: listBy[status] ?? [] }),
      };
    }) as unknown as FailPendingDeps['fetch'],
  };
  return { deps, calls, errors };
}

const patchCalls = (calls: Call[]) => calls.filter((c) => c.init?.method === 'PATCH');

describe('failPendingRequests', () => {
  it('把該 trip 還在跑的 request 標 failed + 指定終結原因', async () => {
    const { deps, calls } = makeDeps({ processing: [{ id: 7 }], open: [] });

    const count = await failPendingRequests(deps, 'trip-a', 'timed_out');

    expect(count).toBe(1);
    const patches = patchCalls(calls);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe('https://api.test/api/requests/7');
    expect(JSON.parse(patches[0].init!.body as string)).toEqual({
      status: 'failed',
      terminalReason: 'timed_out',
    });
  });

  it('open 與 processing 都收', async () => {
    const { deps, calls } = makeDeps({ processing: [{ id: 1 }], open: [{ id: 2 }, { id: 3 }] });
    expect(await failPendingRequests(deps, 'trip-a', 'error')).toBe(3);
    expect(patchCalls(calls).map((c) => c.url)).toEqual([
      'https://api.test/api/requests/1',
      'https://api.test/api/requests/2',
      'https://api.test/api/requests/3',
    ]);
  });

  it('沒有待處理 → 完全不 PATCH（剛完成的 request 不可被清掉）', async () => {
    const { deps, calls } = makeDeps({ processing: [], open: [] });
    expect(await failPendingRequests(deps, 'trip-a', 'timed_out')).toBe(0);
    expect(patchCalls(calls)).toHaveLength(0);
  });

  // ⚠️ 這兩條只斷言「沒 PATCH」是**恆真**的（mutation 實測：拿掉守衛後仍全綠，因為
  // 下游的 null-guard 與 try/catch 會把同樣的結果兜回來）。要能分辨守衛在不在，
  // 必須連它留下的診斷一起驗 —— 那行 log 本來就是「為什麼這輪沒收到」的唯一線索。
  it('列表查詢失敗 → 不 PATCH 且記下 HTTP 狀態（不確定就不動手，交給牆鐘）', async () => {
    const { deps, calls, errors } = makeDeps({}, { listOk: false });
    expect(await failPendingRequests(deps, 'trip-a', 'timed_out')).toBe(0);
    expect(patchCalls(calls)).toHaveLength(0);
    expect(errors.some((e) => e.includes('HTTP 503') && e.includes('本輪不收'))).toBe(true);
  });

  it('列表回非預期 body（null / 非 JSON）→ 不 PATCH 且記下 body 異常', async () => {
    const { deps, calls, errors } = makeDeps({}, { listBody: null });
    expect(await failPendingRequests(deps, 'trip-a', 'timed_out')).toBe(0);
    expect(patchCalls(calls)).toHaveLength(0);
    expect(errors.some((e) => e.includes('body 非預期'))).toBe(true);
  });

  it('查詢帶 tripId scope（不誤收其他行程的請求）', async () => {
    const { deps, calls } = makeDeps({ processing: [], open: [] });
    await failPendingRequests(deps, 'trip-a', 'timed_out');
    for (const c of calls) {
      expect(new URL(c.url).searchParams.get('tripId')).toBe('trip-a');
    }
  });

  it('PATCH 失敗不丟例外（收屍是 cleanup path，不可讓呼叫端炸掉）', async () => {
    const { deps } = makeDeps({ processing: [{ id: 9 }], open: [] }, { patchOk: false });
    await expect(failPendingRequests(deps, 'trip-a', 'timed_out')).resolves.toBe(0);
  });

  it('取 token 失敗不丟例外', async () => {
    const { deps } = makeDeps({ processing: [{ id: 9 }], open: [] });
    deps.getToken = async () => { throw new Error('token 掛了'); };
    await expect(failPendingRequests(deps, 'trip-a', 'timed_out')).resolves.toBe(0);
  });

  it('帶 Bearer service token', async () => {
    const { deps, calls } = makeDeps({ processing: [{ id: 5 }], open: [] });
    await failPendingRequests(deps, 'trip-a', 'timed_out');
    for (const c of calls) {
      expect((c.init?.headers as Record<string, string>)?.Authorization).toBe('Bearer svc-token');
    }
  });
});
