import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { superviseRun, type SuperviseOpts } from '../../scripts/lib/print-run';

/** 假的 child process：stdout/stderr 可餵資料、kill 會記錄，exit/close/error 由測試手動觸發。 */
function fakeChild() {
  const ee = new EventEmitter();
  const stream = () => { const s = new EventEmitter() as EventEmitter & { destroy: () => void; destroyed: boolean }; s.destroyed = false; s.destroy = () => { s.destroyed = true; }; return s; };
  const child = Object.assign(ee, { stdout: stream(), stderr: stream(), signals: [] as string[], kill(sig: string) { child.signals.push(sig); return true; } });
  return child;
}

const T = { timeoutMs: 1000, killGraceMs: 100, hardDeadlineMs: 50 };
function setup(over: Partial<SuperviseOpts> = {}) {
  const child = fakeChild();
  const logs: string[] = [];
  const result = superviseRun(child, {
    ...T, rawMaxBytes: 2000, logMaxBytes: 1000,
    scrub: (t) => t.split('SECRET').join('<redacted>'), writeLog: (t) => { logs.push(t); }, ...over,
  });
  return { child, logs, result };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('superviseRun（claude -p 一輪的計時與收尾）', () => {
  it('exit 0 + close → ok；輸出脫敏後寫 log', async () => {
    const { child, logs, result } = setup();
    child.stdout.emit('data', Buffer.from('hello SECRET world'));
    child.emit('exit', 0); child.emit('close', 0);
    expect(await result).toEqual({ ok: true, timedOut: false, started: true });
    expect(logs).toEqual(['hello <redacted> world']);
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  });

  it('非 0 結束 → ok:false、不算逾時', async () => {
    const { child, result } = setup();
    child.emit('exit', 1); child.emit('close', 1);
    expect(await result).toEqual({ ok: false, timedOut: false, started: true });
  });

  it('token 被切在兩個 chunk 之間：整段收完才脫敏，不會漏', async () => {
    const { child, logs, result } = setup();
    child.stdout.emit('data', Buffer.from('xx SEC'));
    child.stdout.emit('data', Buffer.from('RET yy'));
    child.emit('close', 0);
    await result;
    expect(logs[0]).toBe('xx <redacted> yy');
  });

  it('逾時：先 SIGTERM（不是 SIGKILL）；process 因此結束 → timedOut:true、ok:false', async () => {
    const { child, result } = setup();
    await vi.advanceTimersByTimeAsync(T.timeoutMs);
    expect(child.signals).toEqual(['SIGTERM']);
    child.emit('exit', null); child.emit('close', null);
    expect(await result).toMatchObject({ ok: false, timedOut: true });
    expect(child.signals).toEqual(['SIGTERM']); // 結束後寬限計時器已清掉，不會再補 SIGKILL
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('SIGTERM 被無視：寬限後才 SIGKILL', async () => {
    const { child, result } = setup();
    await vi.advanceTimersByTimeAsync(T.timeoutMs + T.killGraceMs - 1);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.emit('close', null);
    expect(await result).toMatchObject({ timedOut: true, ok: false });
  });

  it('連 SIGKILL 都沒讓它結束：硬性期限一到就放棄等待（鎖不能被卡住的 process 永遠佔住）', async () => {
    const { child, result } = setup();
    await vi.advanceTimersByTimeAsync(T.timeoutMs + T.killGraceMs + T.hardDeadlineMs);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(await result).toMatchObject({ ok: false, timedOut: true, started: true });
  });

  it('exit 了但 close 永遠不來（子孫握著 pipe）：硬性期限後以 exit code 收尾', async () => {
    const { child, result } = setup();
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(T.hardDeadlineMs);
    expect(await result).toEqual({ ok: true, timedOut: false, started: true });
    expect(child.stdout.destroyed).toBe(true);
  });

  it('spawn error → started:false（根本沒開始處理），之後的 close 不會重複收尾', async () => {
    const onErr = vi.fn();
    const { child, logs, result } = setup({ onSpawnError: onErr });
    child.emit('error', new Error('ENOENT'));
    child.emit('close', 127);
    expect(await result).toEqual({ ok: false, timedOut: false, started: false });
    expect(onErr).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
  });

  it('kill() 失敗也會觸發 error（例如 EPERM）：已逾時的 run 不能被誤判成「沒開始」', async () => {
    const { child, result } = setup();
    await vi.advanceTimersByTimeAsync(T.timeoutMs);
    child.emit('error', new Error('kill EPERM'));
    child.emit('exit', null); child.emit('close', null);
    expect(await result).toMatchObject({ ok: false, timedOut: true, started: true });
  });

  it('已經有輸出之後才來的 error 也代表 process 有跑：不收尾成 started:false，交給 exit/close 決定', async () => {
    const { child, result } = setup();
    child.stdout.emit('data', Buffer.from('working…'));
    child.emit('error', new Error('stdio hiccup'));
    child.emit('exit', 0); child.emit('close', 0);
    expect(await result).toEqual({ ok: true, timedOut: false, started: true });
  });

  it('exit、close、硬性期限都來也只收尾一次', async () => {
    const { child, logs, result } = setup();
    child.emit('exit', 0); child.emit('close', 0);
    await result;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(logs).toHaveLength(1);
  });

  it('輸出：原始收集有上限；脫敏後再截斷到 logMaxBytes（切點不會把 token 切成脫敏抓不到的半截）', async () => {
    const { child, logs, result } = setup({ rawMaxBytes: 40, logMaxBytes: 12, rawTailMarginBytes: 0 });
    child.stdout.emit('data', Buffer.from('a'.repeat(10) + 'SECRET' + 'b'.repeat(40)));
    child.stdout.emit('data', Buffer.from('this chunk is dropped'));
    child.emit('close', 0);
    await result;
    // 脫敏在截斷之前：SECRET 先變 <redacted>（不是被切成 SEC）
    expect(logs[0]).toBe('aaaaaaaaaa<r');
    expect(logs[0]!.length).toBe(12);
  });

  it('原始收集被截斷時，結尾留一段安全邊界不寫進 log（token 跨在截斷點上，脫敏抓不到前半截）', async () => {
    const { child, logs, result } = setup({ rawMaxBytes: 10, logMaxBytes: 1000, rawTailMarginBytes: 8 });
    child.stdout.emit('data', Buffer.from('aaaaaaaaaaaaSEC'));
    child.stdout.emit('data', Buffer.from('RET dropped'));
    child.emit('close', 0);
    await result;
    expect(logs[0]).not.toContain('SEC');
    expect(logs[0]).toBe('aaaaaaa');
  });

  it('安全邊界要在脫敏之後才丟：切點落在完整 token 中間時，不能留下脫敏抓不到的半截', async () => {
    const { child, logs, result } = setup({ rawMaxBytes: 10, logMaxBytes: 1000, rawTailMarginBytes: 4 });
    child.stdout.emit('data', Buffer.from('aaaaSECRETbb'));
    child.stdout.emit('data', Buffer.from('dropped'));
    child.emit('close', 0);
    await result;
    expect(logs[0]).not.toContain('SEC');
    expect(logs[0]).toBe('aaaa<redacte');
  });

  it('logMaxBytes 以 bytes 計，不是字元數（中文一字 3 bytes）', async () => {
    const { child, logs, result } = setup({ logMaxBytes: 30 });
    child.stdout.emit('data', Buffer.from('字'.repeat(100)));
    child.emit('close', 0);
    await result;
    expect(Buffer.byteLength(logs[0]!)).toBeLessThanOrEqual(30);
  });

  it('寫 log 失敗不影響結果（best-effort）', async () => {
    const { child, result } = setup({ writeLog: () => { throw new Error('disk full'); } });
    child.emit('close', 0);
    expect(await result).toMatchObject({ ok: true });
  });
});
