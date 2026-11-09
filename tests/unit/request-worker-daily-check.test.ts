import { describe, expect, it, vi } from 'vitest';
import { createRequestWorker, type PrintRunResult, type WorkerDeps } from '../../scripts/lib/request-worker';

function setup(result: PrintRunResult | (() => Promise<PrintRunResult>) = { ok: true, timedOut: false }) {
  const alert = vi.fn();
  const runTrustedPrint = vi.fn(typeof result === 'function' ? result : async () => result);
  const runContainedPrint = vi.fn(async () => ({ ok: true, timedOut: false }));
  const deps = {
    fetch: (async (url: string) => String(url).includes('/api/requests') ? Response.json({ items: [] }) : Response.json({}, { status: 404 })) as unknown as typeof fetch,
    apiBase: 'https://api.test', apiSecret: 's', getServiceToken: async () => 'svc-token',
    userTokenEnabled: (s: string) => s === '/tp-request',
    clock: { now: () => 1_700_000_000_000 }, sleep: async () => {}, pid: 9,
    log: vi.fn(), logError: vi.fn(), alert, containmentReady: () => true,
    runContainedPrint, runTrustedPrint,
  } as unknown as WorkerDeps;
  return { worker: createRequestWorker(deps), alert, runTrustedPrint, runContainedPrint };
}

describe('/tp-daily-check 走 claude -p', () => {
  it('以 service token 呼叫 runTrustedPrint；成功 → spawned，恢復告警 healthy', async () => {
    const { worker, runTrustedPrint, alert } = setup();
    expect(await worker.tick('job', '/tp-daily-check')).toBe('spawned');
    expect(runTrustedPrint).toHaveBeenCalledWith(expect.stringContaining('tripline-tp-daily-check-'), '/tp-daily-check', 'svc-token');
    expect(alert).toHaveBeenCalledWith('daily-check-failed', 'healthy', expect.any(String));
  });

  it.each([
    ['逾時', { ok: false, timedOut: true }],
    ['輪數用盡／非 0 結束', { ok: false, timedOut: false }],
    ['沒能啟動', { ok: false, timedOut: false, started: false }],
  ])('%s → failed + 告警', async (_n, r) => {
    const { worker, alert } = setup(r as PrintRunResult);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('failed');
    expect(alert).toHaveBeenCalledWith('daily-check-failed', 'failed', expect.stringContaining('daily-check'));
  });

  it('runTrustedPrint 丟例外 → failed + 告警，鎖釋放', async () => {
    const { worker, alert } = setup(async () => { throw new Error('boom'); });
    expect(await worker.tick('job', '/tp-daily-check')).toBe('failed');
    expect(alert).toHaveBeenCalledWith('daily-check-failed', 'failed', expect.any(String));
    expect(worker.isRunning('/tp-daily-check')).toBe(false);
  });

  it('重複觸發只跑一個：執行中第二次回 busy，runTrustedPrint 只呼叫一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { worker, runTrustedPrint } = setup(async () => { await gate; return { ok: true, timedOut: false }; });
    const first = worker.tick('job', '/tp-daily-check');
    expect(await worker.tick('job', '/tp-daily-check')).toBe('busy');
    release();
    expect(await first).toBe('spawned');
    expect(runTrustedPrint).toHaveBeenCalledTimes(1);
  });

  it('不佔 /tp-request 的鎖：daily-check 執行中 /tp-request 不是 busy，反之亦然', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { worker } = setup(async () => { await gate; return { ok: true, timedOut: false }; });
    const daily = worker.tick('job', '/tp-daily-check');
    expect(worker.isRunning('/tp-request')).toBe(false);
    expect(await worker.tick('job', '/tp-request')).toBe('idle'); // 無 pending，但沒被 daily-check 擋成 busy
    release();
    await daily;
  });
});
