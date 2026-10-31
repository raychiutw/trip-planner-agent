/**
 * 一輪 `claude -p` 的計時與收尾（從 tripline-api-server.ts 抽出）。
 *
 * 抽成獨立模組的理由同 request-worker：api-server import 即啟動 server，無法在 vitest 執行；
 * 而這段正是「鎖會不會被卡死」「token 會不會漏進 log」的關鍵，必須能用 fake timers 驗行為。
 *
 * 行為：
 * - 逾時先 SIGTERM（sudo 會轉發給 tp-agent 的 claude；直接 SIGKILL 只砍得到 sudo，claude 會變孤兒，實測），
 *   寬限後 SIGKILL，再給一段時間仍沒結束就硬性放棄等待。
 * - 'close' 要等所有持有 pipe 的子孫都結束；claude 退了但 MCP 子程序還活著時會被拖住，所以也聽 'exit'
 *   並在短暫等待後以 exit code 收尾。
 * - 輸出整段收完才脫敏（token 不會被切在兩個 chunk 之間漏過去）；原始收集有上限（防被注入的大量輸出吃記憶體），
 *   脫敏之後才截斷到 log 上限（切點不會把 token 切成脫敏抓不到的半截）。
 * - 收尾只會執行一次（'error'、'exit'、'close' 與各期限都可能各來一次）。
 */
import type { PrintRunResult } from './request-worker';

/** 單輪逾時：比舊的 90 分鐘 orphan cap 短，但要容得下大型請求（#237：多天餐廳替換超過 40 分鐘）。 */
export const PRINT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** SIGTERM 之後多久還沒結束才 SIGKILL。 */
export const PRINT_KILL_GRACE_MS = 10_000;
/** process 已結束（或已 SIGKILL）後，再等多久 stdio 還沒關就放棄等待。 */
export const PRINT_HARD_DEADLINE_MS = 5_000;
/** 單輪 log 檔上限；原始收集留 2 倍緩衝。 */
export const PRINT_LOG_MAX_BYTES = 1024 * 1024;
export const PRINT_RAW_MAX_BYTES = 2 * PRINT_LOG_MAX_BYTES;
/** 截斷時結尾留的安全邊界，要大於任何 token 長度（restrict token 約數百字元）。 */
export const PRINT_RAW_TAIL_MARGIN_BYTES = 4096;

interface StreamLike {
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  destroy(): unknown;
}

/** child_process.ChildProcess 的最小子集（測試用 EventEmitter 假的即可）。 */
export interface RunChild {
  stdout: StreamLike;
  stderr: StreamLike;
  kill(signal: 'SIGTERM' | 'SIGKILL'): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit' | 'close', cb: (code: number | null) => void): unknown;
}

export interface SuperviseOpts {
  timeoutMs: number;
  killGraceMs: number;
  hardDeadlineMs: number;
  rawMaxBytes: number;
  logMaxBytes: number;
  /** 原始收集被截斷時，脫敏後再丟掉結尾這麼多 bytes：token 若跨在截斷點上，脫敏只看得到前半截，會原樣寫進 log。 */
  rawTailMarginBytes?: number;
  scrub: (text: string) => string;
  writeLog: (text: string) => void;
  onSpawnError?: (err: Error) => void;
}

export function superviseRun(child: RunChild, o: SuperviseOpts): Promise<PrintRunResult> {
  return new Promise<PrintRunResult>((resolve) => {
    let timedOut = false;
    let done = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const collect = (b: Buffer) => { if (bytes < o.rawMaxBytes) { chunks.push(b); bytes += b.length; } else truncated = true; };
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finish = (ok: boolean, started = true) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        // 先整段脫敏，再丟掉被截斷的尾巴（跨在截斷點上的 token 前綴必落在尾巴內），最後才以 bytes 截到上限。
        let out = Buffer.from(o.scrub(Buffer.concat(chunks).toString()));
        if (truncated) out = out.subarray(0, Math.max(0, out.length - (o.rawTailMarginBytes ?? PRINT_RAW_TAIL_MARGIN_BYTES)));
        o.writeLog(out.subarray(0, o.logMaxBytes).toString());
      } catch { /* best-effort log */ }
      resolve({ ok: ok && !timedOut, timedOut, started });
    };

    timers.push(setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      timers.push(setTimeout(() => {
        child.kill('SIGKILL');
        timers.push(setTimeout(() => finish(false), o.hardDeadlineMs));
      }, o.killGraceMs));
    }, o.timeoutMs));

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      o.onSpawnError?.(err);
      // 'error' 不只在 spawn 失敗時來，kill() 失敗（例如 EPERM）也會：已逾時、或已經有輸出，代表 process 有跑，
      // 不能算「沒開始」（worker 會因此不收屍而讓同一批請求被原樣重跑），交給 exit／close／期限收尾。
      if (timedOut || bytes > 0) return;
      finish(false, false);
    });
    child.on('exit', (code) => { timers.push(setTimeout(() => finish(code === 0), o.hardDeadlineMs)); });
    child.on('close', (code) => finish(code === 0));
  });
}
