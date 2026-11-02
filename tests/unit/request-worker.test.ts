/**
 * #1264 request worker —— 用 fake api / tmux / clock 從 interface 驗 tick 路徑，
 * 取代 api-server-*.test 內 readFileSync + regex 的守衛。
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequestWorker, sessionPrefixForSkill, getKnownSessionPrefixes, ORPHAN_MAX_AGE_MS, type WorkerDeps } from '../../scripts/lib/request-worker';
// 與 web／api 判定請求逾時的門檻（trip-planner 的 functions/api/_requestTermination.ts 的 REQUEST_STALE_MINUTES）相同。
// 這是跨專案的不變量：worker 的總執行時間必須小於它。agent repo 看不到那份檔案，所以在這裡以常數鏡射；
// 兩邊改動時要同步（目前沒有自動守衛，見 PR 內文）。
const REQUEST_STALE_MINUTES = 100;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeDeps(over: Partial<WorkerDeps> & { sessions?: string[]; pending?: { id: number; tripId: string } | null; userToken?: boolean } = {}) {
  const sessions = over.sessions ?? [];
  const nowMs = 1_700_000_000_000;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/requests?status=')) {
      const items = !url.includes('tripId=') && over.pending && url.includes('status=processing') ? [over.pending] : [];
      return jsonRes(200, { items });
    }
    if (url.endsWith('/api/oauth/mint-restricted')) {
      const body = JSON.parse(String(init?.body)) as { request_id: string };
      return jsonRes(200, { access_token: `restricted-${body.request_id}`, restrict_trip: over.pending?.tripId });
    }
    return jsonRes(404, {});
  });
  let prompt = '❯ ';
  let killed = false;
  const deps: WorkerDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    apiBase: 'https://api.test',
    apiSecret: 'secret',
    getServiceToken: vi.fn(async () => 'svc-token'),
    userTokenEnabled: (skill) => (over.userToken ?? true) && skill === '/tp-request',
    tmux: {
      list: vi.fn((format: string) => {
        if (format.includes('session_created')) return sessions.map((s) => `${s}|${Math.floor(nowMs / 1000) - 10}`).join('\n');
        return sessions.join('\n');
      }),
      kill: vi.fn(() => { killed = true; }),
      has: vi.fn(() => !killed),
    },
    clock: { now: () => nowMs },
    sleep: vi.fn(async () => undefined),
    pid: 4242,
    log: vi.fn(),
    logError: vi.fn(),
    alert: vi.fn(),
    containmentReady: vi.fn(() => true),
    pane: { capture: () => prompt, sendKeys: (_name, keys) => { prompt = keys === 'Enter' ? '❯ ' : `❯ ${keys}`; } },
    attachLog: vi.fn(),
    runContainedPrint: vi.fn(async () => ({ ok: true, timedOut: false })),
    createPlainSession: vi.fn(async () => true),
    ...over,
  };
  return { deps, fetchMock };
}

describe('prefix 規則', () => {
  it('sessionPrefixForSkill → tripline-{slug}-；未白名單 skill 拒絕', () => {
    expect(sessionPrefixForSkill('/tp-request')).toBe('tripline-tp-request-');
    expect(sessionPrefixForSkill('/tp-daily-check')).toBe('tripline-tp-daily-check-');
    expect(() => sessionPrefixForSkill('/rm-rf')).toThrow(/Disallowed/);
  });
  it('getKnownSessionPrefixes 含兩個 skill prefix + legacy tripline-request-', () => {
    expect(getKnownSessionPrefixes()).toEqual(['tripline-tp-request-', 'tripline-tp-daily-check-', 'tripline-request-']);
  });
});

describe('tick', () => {
  it('無 pending → idle，不 spawn', async () => {
    const { deps } = makeDeps({ pending: null });
    const w = createRequestWorker(deps);
    expect(await w.tick('api')).toBe('idle');
    expect(deps.runContainedPrint).not.toHaveBeenCalled();
    expect(deps.createPlainSession).not.toHaveBeenCalled();
  });

  it('有 pending → peek(processing→open) → mint-restricted(request_id, API_SECRET) → claude -p，run 名 = prefix + now + pid + -r<輪>', async () => {
    const { deps, fetchMock } = makeDeps({ pending: { id: 77, tripId: 'trip-a' } });
    const w = createRequestWorker(deps);
    expect(await w.tick('api')).toBe('spawned');
    const mint = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/mint-restricted'))!;
    expect(JSON.parse(String((mint[1] as RequestInit).body))).toEqual({ request_id: '77' });
    expect((mint[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(deps.runContainedPrint).toHaveBeenCalledWith('tripline-tp-request-1700000000000-4242-r1', '/tp-request', 'restricted-77', 'trip-a');
    expect(w.status()).toMatchObject({ processedCount: 1, running: false });
  });

  it('同 skill 已有 session（含 legacy prefix）→ busy 不重複 spawn', async () => {
    const { deps } = makeDeps({ pending: { id: 1, tripId: 't' }, sessions: ['tripline-request-123-1'] });
    const w = createRequestWorker(deps);
    expect(await w.tick('job')).toBe('busy');
    expect(deps.runContainedPrint).not.toHaveBeenCalled();
  });

  it('同 skill 併發 tick → 第二個 busy（per-skill 鎖）；不同 skill 不互鎖', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = () => r(); });
    const { deps } = makeDeps({ pending: { id: 1, tripId: 't' }, runContainedPrint: vi.fn(async () => { await gate; return { ok: true, timedOut: false }; }) });
    const w = createRequestWorker(deps);
    const first = w.tick('api', '/tp-request');
    expect(w.isRunning('/tp-request')).toBe(true);
    expect(await w.tick('api', '/tp-request')).toBe('busy');
    expect(await w.tick('job', '/tp-daily-check')).toBe('spawned'); // service token → plain spawn
    release();
    expect(await first).toBe('spawned');
  });

  it('mint 失敗 → 不 fallback service token、alert mint-*、回 idle', async () => {
    const { deps } = makeDeps({ pending: { id: 9, tripId: 't' } });
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url.includes('/api/requests?') ? jsonRes(200, { items: [{ id: 9, tripId: 't' }] }) : new Response('boom', { status: 500 }));
    const w = createRequestWorker(deps);
    expect(await w.tick('api')).toBe('idle');
    expect(deps.alert).toHaveBeenCalledWith('mint-MINT_FAILED', 'failed', expect.stringContaining('mint-restricted'));
    expect(deps.createPlainSession).not.toHaveBeenCalled();
    expect(deps.runContainedPrint).not.toHaveBeenCalled();
  });

  it('containment 未就緒 → /tp-request 拒絕 spawn（failed + alert）', async () => {
    const { deps } = makeDeps({ pending: { id: 1, tripId: 't' }, containmentReady: () => false });
    const w = createRequestWorker(deps);
    expect(await w.tick('api')).toBe('failed');
    expect(deps.alert).toHaveBeenCalledWith('containment-not-ready', 'failed', expect.any(String));
    expect(deps.createPlainSession).not.toHaveBeenCalled();
  });

  it('flag OFF 時 /tp-request 落到未-contained 路徑 → 拒絕；/tp-daily-check 走 service token plain spawn', async () => {
    const { deps } = makeDeps({ userToken: false });
    const w = createRequestWorker(deps);
    expect(await w.tick('api', '/tp-request')).toBe('failed');
    expect(deps.alert).toHaveBeenCalledWith('tp-request-uncontained-refused', 'failed', expect.any(String));
    expect(await w.tick('job', '/tp-daily-check')).toBe('spawned');
    expect(deps.createPlainSession).toHaveBeenCalledWith('tripline-tp-daily-check-1700000000000-4242', '/tp-daily-check', 'svc-token');
  });
});

describe('cleanupOrphans', () => {
  it('只清自家 prefix 且超過 maxAge 的 session；`|` 分隔', () => {
    const now = 1_700_000_000_000;
    const old = Math.floor(now / 1000) - 2 * 60 * 60;
    const fresh = Math.floor(now / 1000) - 60;
    const { deps } = makeDeps({
      tmux: {
        list: () => [`tripline-tp-request-1-1|${old}`, `tripline-request-legacy|${old}`, `tripline-tp-request-2-2|${fresh}`, `someone-else|${old}`, `bad line`].join('\n'),
        kill: vi.fn(),
      },
    });
    const w = createRequestWorker(deps);
    expect(w.cleanupOrphans(ORPHAN_MAX_AGE_MS)).toBe(2);
    expect(deps.tmux.kill).toHaveBeenCalledWith('tripline-tp-request-1-1');
    expect(deps.tmux.kill).toHaveBeenCalledWith('tripline-request-legacy');
    expect(deps.tmux.kill).not.toHaveBeenCalledWith('someone-else');
    expect(deps.tmux.kill).not.toHaveBeenCalledWith('tripline-tp-request-2-2');
  });
  it('tmux 不在 → 0', () => {
    const { deps } = makeDeps({ tmux: { list: () => null, kill: vi.fn() } });
    expect(createRequestWorker(deps).cleanupOrphans(1)).toBe(0);
  });
});

describe('#1265 收屍（ADR-0007 第一層）', () => {
  /** fake clock：每次 sleep 把時間往前撥 15s；fetch 回該 trip 是否仍有 pending。 */
  function reapDeps(opts: { pendingRounds: number; failPatchOk?: boolean }) {
    let now = 1_700_000_000_000;
    let rounds = 0;
    const patched: string[] = [];
    let alive = true;
    const { deps } = makeDeps({
      clock: { now: () => now },
      sleep: vi.fn(async (ms: number) => { now += ms; rounds++; }),
      tmux: { list: () => '', kill: vi.fn(() => { alive = false; }), has: vi.fn(() => alive) },
    });
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/requests?status=') && url.includes('tripId=')) {
        const still = rounds < opts.pendingRounds;
        // 只在 processing 回同一筆，避免 processing + open 各回一次被當兩筆
        return jsonRes(200, { items: still && url.includes('status=processing') ? [{ id: 5 }] : [] });
      }
      if (/\/api\/requests\/\d+$/.test(url) && init?.method === 'PATCH') {
        patched.push(String(init.body));
        return jsonRes(opts.failPatchOk === false ? 500 : 200, {});
      }
      return jsonRes(404, {});
    });
    return { deps, patched, clock: () => now };
  }

  it('牆鐘（第二層 100 分鐘）必須大於 orphan cap（第一層 90 分鐘），兩層時鐘錯開', () => {
    expect(REQUEST_STALE_MINUTES * 60_000).toBeGreaterThan(ORPHAN_MAX_AGE_MS);
  });

  it('reap(tripId, error)：spawn 失敗那類走 error 原因', async () => {
    const { deps, patched } = reapDeps({ pendingRounds: 999 });
    const w = createRequestWorker(deps);
    expect(await w.reap('trip-a', 'error')).toBe(1);
    expect(JSON.parse(patched[0]!)).toMatchObject({ status: 'failed', terminalReason: 'error' });
  });
});

describe('tripHasPending 保守判斷', () => {
  it('API 非 200 → true（不誤殺）；fetch 丟例外 → true；兩狀態皆空 → false', async () => {
    const { deps } = makeDeps();
    const w = createRequestWorker(deps);
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('x', { status: 503 }));
    expect(await w.tripHasPending('t')).toBe(true);
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('net'); });
    expect(await w.tripHasPending('t')).toBe(true);
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => jsonRes(200, { items: [] }));
    expect(await w.tripHasPending('t')).toBe(false);
  });
});
