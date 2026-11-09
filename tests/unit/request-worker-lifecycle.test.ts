import { describe, expect, it } from 'vitest';
import { createRequestWorker, type WorkerDeps } from '../../scripts/lib/request-worker';

/**
 * 信任 skill（/tp-daily-check）`claude -p` 的生命週期，加上 contained 路徑共用的前置關卡
 * （containment、mint token）。contained `claude -p` 本身的行為見 request-worker-print-mode.test.ts。
 */
function fakeHost() {
  let now = 1_700_000_000_000;
  let pending = true;
  const effects: string[] = [];
  const deps: WorkerDeps = {
    apiBase: 'https://api.test', apiSecret: 'bootstrap', pid: 7,
    getServiceToken: async () => 'service', userTokenEnabled: (skill) => skill === '/tp-request',
    clock: { now: () => now }, sleep: async (ms) => { now += ms; },
    log: () => {}, logError: () => {}, alert: () => {}, containmentReady: () => true,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('mint-restricted')) return Response.json({ access_token: 'trip-token', restrict_trip: 't1' });
      if (url.pathname === '/api/requests') return Response.json({ items: pending && url.searchParams.get('status') === 'processing' ? [{ id: 1, tripId: 't1' }] : [] });
      if (init?.method === 'PATCH') { effects.push(`reap:${JSON.parse(String(init.body)).terminalReason}`); pending = false; return Response.json({}); }
      return Response.json({}, { status: 404 });
    },
    runContainedPrint: async () => { effects.push('run-print'); pending = false; return { ok: true, timedOut: false }; },
    runTrustedPrint: async () => { effects.push('run-trusted'); return { ok: true, timedOut: false }; },
  };
  return { deps, effects, hasPending: () => pending, setPending: (value: boolean) => { pending = value; } };
}

describe('request worker lifecycle through the production interface', () => {
  it('trusted skill failure releases its own lock without reaping trip requests', async () => {
    const host = fakeHost();
    host.deps.runTrustedPrint = async () => ({ ok: false, timedOut: true });
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('failed');
    expect(host.hasPending()).toBe(true);
    expect(host.effects.some((effect) => effect.startsWith('reap:'))).toBe(false);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it.each(['containment', 'token'] as const)('%s failure stays closed and retries without reaping pending work', async (stage) => {
    const host = fakeHost(); const originalFetch = host.deps.fetch;
    if (stage === 'containment') host.deps.containmentReady = () => false;
    else host.deps.fetch = (input, init) => String(input).endsWith('/mint-restricted') ? Promise.resolve(Response.json({}, { status: 403 })) : originalFetch(input, init);
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job')).toBe(stage === 'containment' ? 'failed' : 'idle');
    expect(host.hasPending()).toBe(true);
    expect(host.effects).toEqual([]);
    expect(worker.status().running).toBe(false);
    host.deps.containmentReady = () => true; host.deps.fetch = originalFetch;
    expect(await worker.tick('api')).toBe('spawned');
    expect(host.effects).toContain('run-print');
  });

  it('keeps a per-skill lock while another allowed skill can start', async () => {
    const host = fakeHost();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = host.deps.runContainedPrint;
    host.deps.runContainedPrint = async (...args) => { await gate; return run(...args); };
    const worker = createRequestWorker(host.deps);
    const first = worker.tick('api');
    expect(await worker.tick('job')).toBe('busy');
    expect(await worker.tick('job', '/tp-daily-check')).toBe('spawned');
    release(); expect(await first).toBe('spawned');
    expect(host.effects.filter((effect) => effect === 'run-print')).toHaveLength(1);
    expect(host.effects.filter((effect) => effect === 'run-trusted')).toHaveLength(1);
    expect(worker.status().runningSkills).toEqual([]);
  });
});
