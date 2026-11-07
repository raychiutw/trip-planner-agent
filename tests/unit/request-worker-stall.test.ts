/**
 * 請求停滯告警：每次 tick 後看「最老的待處理請求」等多久，超過門檻就 alert('request-stall', 'failed')。
 * 只在狀態變化時發（failed 一次、恢復 healthy 一次），告警訊息不得含使用者內容或 email。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createRequestWorker,
  parseStallThresholdMs,
  STALL_ALERT_KEY,
  DEFAULT_STALL_THRESHOLD_MS,
  type WorkerDeps,
} from '../../scripts/lib/request-worker';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const SECRET_MESSAGE = '我的護照號碼是 A123456789，請幫我訂飯店';
const SECRET_EMAIL = 'victim@example.com';

/** API 真實形狀：D1 `datetime('now')` 經 deepCamel → createdAt，格式 `YYYY-MM-DD HH:MM:SS`（UTC、無時區）。 */
const sqliteTime = (ageMin: number) => new Date(NOW - ageMin * MIN).toISOString().slice(0, 19).replace('T', ' ');
const row = (id: number, ageMin: number, tripId = 'trip-a') => ({
  id, tripId, createdAt: sqliteTime(ageMin), message: SECRET_MESSAGE, submittedBy: SECRET_EMAIL, status: 'open',
});

type Queue = { processing: unknown[]; open: unknown[] };

function setup(opts: { sessions?: string[]; startedFalse?: boolean; threshold?: number } = {}) {
  const queue: Queue = { processing: [], open: [] };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const m = /\/api\/requests\?status=(processing|open)&sort=asc&limit=1/.exec(url);
    if (m) return new Response(JSON.stringify({ items: queue[m[1] as keyof Queue].slice(0, 1) }), { status: 200 });
    if (url.includes('/api/requests?')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
    if (url.endsWith('/api/oauth/mint-restricted')) {
      const body = JSON.parse(String(init?.body)) as { request_id: string };
      return new Response(JSON.stringify({ access_token: `t-${body.request_id}`, restrict_trip: 'trip-a' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  const alert = vi.fn();
  const sessions = opts.sessions ?? [];
  const deps: WorkerDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    apiBase: 'https://api.test',
    apiSecret: 'secret',
    getServiceToken: async () => 'svc',
    userTokenEnabled: (s) => s === '/tp-request',
    tmux: { list: () => sessions.join('\n'), kill: vi.fn(), has: () => false },
    clock: { now: () => NOW },
    sleep: async () => undefined,
    pid: 1,
    log: vi.fn(),
    logError: vi.fn(),
    alert,
    containmentReady: () => true,
    pane: { capture: () => '', sendKeys: () => undefined },
    attachLog: vi.fn(),
    runContainedPrint: vi.fn(async () => ({ ok: false, timedOut: false, started: !opts.startedFalse ? true : false })),
    createPlainSession: vi.fn(async () => true),
    stallThresholdMs: opts.threshold,
  };
  return { worker: createRequestWorker(deps), queue, alert, deps };
}

const BUSY = ['tripline-tp-request-1-1']; // hasActiveSession → tick 回 busy
const stallCalls = (alert: ReturnType<typeof vi.fn>) => alert.mock.calls.filter((c) => c[0] === STALL_ALERT_KEY);

describe('request-stall 告警', () => {
  it('worker 一直 busy、最老請求超過門檻 → 告警一次，訊息含編號／分鐘／行程／tick 結果', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    expect(await worker.tick('job')).toBe('busy');
    expect(stallCalls(alert)).toHaveLength(1);
    const [key, state, message] = stallCalls(alert)[0] as [string, string, string];
    expect(key).toBe('request-stall');
    expect(state).toBe('failed');
    expect(message).toContain('77');
    expect(message).toContain('45');
    expect(message).toContain('trip-a');
    expect(message).toContain('busy');
  });

  it('持續停滯多個 tick → 不重複告警', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    for (let i = 0; i < 5; i++) await worker.tick('job');
    expect(stallCalls(alert)).toHaveLength(1);
  });

  it('清單清空 → healthy 一次，之後不再發', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    await worker.tick('job');
    queue.open = [];
    await worker.tick('job');
    await worker.tick('job');
    expect(stallCalls(alert).map((c) => c[1])).toEqual(['failed', 'healthy']);
  });

  it('最老請求回到門檻內（換成新請求）→ healthy', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    await worker.tick('job');
    queue.open = [row(78, 2)];
    await worker.tick('job');
    expect(stallCalls(alert).map((c) => c[1])).toEqual(['failed', 'healthy']);
  });

  it('未超過門檻 → 不告警，也不發 healthy', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 19)];
    await worker.tick('job');
    await worker.tick('job');
    expect(stallCalls(alert)).toHaveLength(0);
  });

  it('tick 失敗（claude -p 沒起來）且請求很老 → 告警並標示 failed', async () => {
    const { worker, queue, alert } = setup({ startedFalse: true });
    queue.open = [row(5, 90)];
    expect(await worker.tick('job')).toBe('failed');
    const calls = stallCalls(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toContain('failed');
    expect(calls[0]![2]).toContain('90');
  });

  it('停擺後恢復：第一次 tick 就發現很老的 processing 請求 → 告警；用 processing 與 open 兩邊最老者', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.processing = [row(10, 30)];
    queue.open = [row(11, 300)];
    await worker.tick('job');
    const calls = stallCalls(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toContain('11'); // 取最老（open 的 #11，300 分鐘）
    expect(calls[0]![2]).toContain('300');
  });

  it('訊息不含請求內容或 email', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    await worker.tick('job');
    const msg = stallCalls(alert)[0]![2] as string;
    expect(msg).not.toContain(SECRET_EMAIL);
    expect(msg).not.toContain('example.com');
    expect(msg).not.toContain('A123456789');
    expect(msg).not.toContain('護照');
  });

  it('門檻可注入：stallThresholdMs 調小就在較短時間內告警', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY, threshold: 5 * MIN });
    queue.open = [row(77, 6)];
    await worker.tick('job');
    expect(stallCalls(alert)).toHaveLength(1);
  });

  it('查詢隊列失敗（fetch 拋錯）→ 不改變告警狀態', async () => {
    const { worker, queue, alert, deps } = setup({ sessions: BUSY });
    queue.open = [row(77, 45)];
    await worker.tick('job');
    (deps.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('network'); });
    await worker.tick('job');
    expect(stallCalls(alert).map((c) => c[1])).toEqual(['failed']);
  });

  it('createdAt 缺漏或無法解析 → 略過，不誤報', async () => {
    const { worker, queue, alert } = setup({ sessions: BUSY });
    queue.open = [{ id: 1, tripId: 'trip-a' }, ];
    await worker.tick('job');
    queue.open = [{ id: 1, tripId: 'trip-a', createdAt: 'not-a-date' }];
    await worker.tick('job');
    expect(stallCalls(alert)).toHaveLength(0);
  });

  it('/tp-daily-check 的 tick 不做請求停滯檢查', async () => {
    const { worker, queue, alert } = setup();
    queue.open = [row(77, 45)];
    await worker.tick('job', '/tp-daily-check').catch(() => undefined);
    expect(stallCalls(alert)).toHaveLength(0);
  });
});

describe('parseStallThresholdMs（環境變數覆寫）', () => {
  it('未設定 → 預設 20 分鐘', () => {
    expect(DEFAULT_STALL_THRESHOLD_MS).toBe(20 * MIN);
    expect(parseStallThresholdMs(undefined)).toBe(20 * MIN);
    expect(parseStallThresholdMs('')).toBe(20 * MIN);
  });
  it('正數分鐘 → 換算毫秒', () => {
    expect(parseStallThresholdMs('35')).toBe(35 * MIN);
    expect(parseStallThresholdMs('0.5')).toBe(30_000);
  });
  it('非數字／零／負數 → 退回預設（不讓壞設定把告警關掉）', () => {
    for (const bad of ['abc', '0', '-5', 'NaN', 'Infinity']) expect(parseStallThresholdMs(bad)).toBe(20 * MIN);
  });
});
