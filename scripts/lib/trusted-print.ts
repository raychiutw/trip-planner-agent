/**
 * 信任 skill（/tp-daily-check）的 `claude -p` 執行：不隔離（見 GLOSSARY.md「信任 skill」）。
 *
 * 與 contained 路徑共用 superviseRun 的計時與收尾，差別只有：權限 `--dangerously-skip-permissions`（行為與舊互動版一致）、
 * 逾時 60 分鐘、輪數 200，以及 token 走子行程環境變數（不放 argv，`ps` 看不到）。
 * 抽成獨立模組的理由同 print-run：api-server import 即啟動 server，無法在 vitest 驗行為。
 */
import {
  superviseRun, PRINT_KILL_GRACE_MS, PRINT_HARD_DEADLINE_MS, PRINT_LOG_MAX_BYTES, PRINT_RAW_MAX_BYTES, type RunChild,
} from './print-run';
import type { PrintRunResult } from './request-worker';

export const TRUSTED_RUN_TIMEOUT_MS = 60 * 60 * 1000;
export const TRUSTED_MAX_TURNS = 200;

export interface TrustedPrintOpts {
  spawn: (file: string, args: string[], o: { cwd: string; env: Record<string, string | undefined> }) => RunChild;
  claudeBin: string;
  cwd: string;
  baseEnv: Record<string, string | undefined>;
  token: string;
  skillCommand: string;
  writeLog: (text: string) => void;
  onSpawnError?: (err: Error) => void;
}

export async function runTrustedPrint(o: TrustedPrintOpts): Promise<PrintRunResult> {
  let child: RunChild;
  try {
    child = o.spawn(
      o.claudeBin,
      ['-p', o.skillCommand, '--max-turns', String(TRUSTED_MAX_TURNS), '--dangerously-skip-permissions'],
      { cwd: o.cwd, env: { ...o.baseEnv, TRIPLINE_API_TOKEN: o.token } },
    );
  } catch (err) {
    o.onSpawnError?.(err instanceof Error ? err : new Error(String(err)));
    return { ok: false, timedOut: false, started: false };
  }
  const scrub = (t: string) => t
    .split(o.token).join('<redacted>')
    .replace(/[Bb]earer [A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>');
  return superviseRun(child, {
    timeoutMs: TRUSTED_RUN_TIMEOUT_MS, killGraceMs: PRINT_KILL_GRACE_MS, hardDeadlineMs: PRINT_HARD_DEADLINE_MS,
    rawMaxBytes: PRINT_RAW_MAX_BYTES, logMaxBytes: PRINT_LOG_MAX_BYTES,
    scrub, writeLog: o.writeLog, onSpawnError: o.onSpawnError,
  });
}
