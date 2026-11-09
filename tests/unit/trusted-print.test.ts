import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTrustedPrint, TRUSTED_MAX_TURNS, TRUSTED_RUN_TIMEOUT_MS } from '../../scripts/lib/trusted-print';

const TOKEN = 'svc-token-abcdef123456';

function fakeChild() {
  const stream = () => { const s = new EventEmitter() as EventEmitter & { destroy: () => void }; s.destroy = () => {}; return s; };
  const ee = new EventEmitter();
  const child = Object.assign(ee, { stdout: stream(), stderr: stream(), signals: [] as string[], kill(sig: string) { child.signals.push(sig); return true; } });
  return child;
}

function setup() {
  const child = fakeChild();
  const calls: Array<{ file: string; args: string[]; env: Record<string, string | undefined>; cwd: string }> = [];
  const logs: string[] = [];
  const result = runTrustedPrint({
    spawn: (file, args, o) => { calls.push({ file, args, env: o.env, cwd: o.cwd }); return child; },
    claudeBin: '/bin/claude', cwd: '/app', baseEnv: { PATH: '/usr/bin' }, token: TOKEN,
    skillCommand: '/tp-daily-check', writeLog: (t) => { logs.push(t); },
  });
  return { child, calls, logs, result };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('runTrustedPrint（/tp-daily-check 走 claude -p）', () => {
  it('以 -p 執行 skill、--max-turns 200；token 只在環境變數，argv 不含', async () => {
    const { child, calls, result } = setup();
    child.emit('exit', 0); child.emit('close', 0);
    expect(await result).toMatchObject({ ok: true, timedOut: false });
    const c = calls[0]!;
    expect(c.file).toBe('/bin/claude');
    expect(c.args.slice(0, 2)).toEqual(['-p', '/tp-daily-check']);
    expect(c.args).toContain('--dangerously-skip-permissions');
    expect(c.args[c.args.indexOf('--max-turns') + 1]).toBe('200');
    expect(TRUSTED_MAX_TURNS).toBe(200);
    expect(c.args.join(' ')).not.toContain(TOKEN);
    expect(c.env.TRIPLINE_API_TOKEN).toBe(TOKEN);
    expect(c.cwd).toBe('/app');
  });

  it('60 分鐘逾時 → SIGTERM、timedOut:true、ok:false', async () => {
    expect(TRUSTED_RUN_TIMEOUT_MS).toBe(60 * 60_000);
    const { child, result } = setup();
    await vi.advanceTimersByTimeAsync(TRUSTED_RUN_TIMEOUT_MS - 1);
    expect(child.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM']);
    child.emit('exit', null); child.emit('close', null);
    expect(await result).toMatchObject({ ok: false, timedOut: true });
  });

  it('非 0 結束（含 max-turns 用盡）→ ok:false、不算逾時；log 內 token 被脫敏', async () => {
    const { child, logs, result } = setup();
    child.stdout.emit('data', Buffer.from(`Reached max turns ${TOKEN}`));
    child.emit('exit', 1); child.emit('close', 1);
    expect(await result).toMatchObject({ ok: false, timedOut: false });
    expect(logs.join('')).not.toContain(TOKEN);
  });

  it('spawn 丟例外 → started:false', async () => {
    const r = await runTrustedPrint({
      spawn: () => { throw new Error('ENOENT'); }, claudeBin: 'x', cwd: '/', baseEnv: {}, token: TOKEN,
      skillCommand: '/tp-daily-check', writeLog: () => {},
    });
    expect(r).toMatchObject({ ok: false, started: false });
  });
});
