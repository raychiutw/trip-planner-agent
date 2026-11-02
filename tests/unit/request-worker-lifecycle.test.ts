import { describe, expect, it } from 'vitest';
import { createRequestWorker, type WorkerDeps } from '../../scripts/lib/request-worker';

/**
 * plain tmux session（/tp-daily-check 等信任 skill）的生命週期，加上 contained 路徑共用的前置關卡
 * （containment、mint token）。contained `claude -p` 本身的行為見 request-worker-print-mode.test.ts。
 */
function fakeHost() {
  let now = 1_700_000_000_000;
  let pending = true;
  const sessions = new Set<string>();
  let prompt = '❯ ';
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
    tmux: {
      list: (format) => [...sessions].map((name) => format.includes('created') ? `${name}|${Math.floor(now / 1000)}` : name).join('\n'),
      has: (name) => sessions.has(name),
      kill: (name) => { effects.push(`kill:${name}`); sessions.delete(name); },
    },
    runContainedPrint: async () => { effects.push('run-print'); pending = false; return { ok: true, timedOut: false }; },
    createPlainSession: async (name) => { effects.push('create-plain'); sessions.add(name); return true; },
    attachLog: () => { effects.push('log-attached'); },
    pane: {
      capture: () => prompt,
      sendKeys: (_name, keys) => {
        effects.push(`keys:${keys}`);
        prompt = keys === 'Enter' ? '❯ ' : `❯ ${keys}`;
      },
    },
  };
  return { deps, effects, hasSession: () => sessions.size > 0, hasPending: () => pending, setPending: (value: boolean) => { pending = value; } };
}

describe('request worker lifecycle through the production interface', () => {
  it('plain skill startup failure releases its own lock without reaping trip requests', async () => {
    const host = fakeHost(); host.deps.pane.capture = () => '';
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('failed');
    expect(host.hasSession()).toBe(false);
    expect(host.hasPending()).toBe(true);
    expect(host.effects.some((effect) => effect.startsWith('reap:'))).toBe(false);
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('plain skill drives the real REPL protocol (send skill, Enter) and leaves cleanup to the skill itself', async () => {
    const host = fakeHost(); const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('spawned');
    expect(host.effects).toContain('keys:/tp-daily-check');
    expect(host.effects).toContain('keys:Enter');
    expect(host.effects).toContain('log-attached');
    expect(worker.status().runningSkills).toEqual([]);
  });

  it('does not reap anything when a plain session cannot actually be killed after a failed startup', async () => {
    const host = fakeHost(); host.deps.pane.capture = () => '';
    host.deps.tmux.kill = () => { host.effects.push('kill-failed'); };
    const worker = createRequestWorker(host.deps);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('failed');
    expect(host.hasSession()).toBe(true);
    expect(host.effects.some((effect) => effect.startsWith('reap:'))).toBe(false);
    expect(worker.status().running).toBe(false);
    expect(await worker.tick('job', '/tp-daily-check')).toBe('busy');
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
    expect(host.effects.filter((effect) => effect === 'create-plain')).toHaveLength(1);
    expect(worker.status().runningSkills).toEqual([]);
  });
});
