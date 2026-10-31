// 型別相容性樣本（由 print-run-types.test.ts 以 tsc --strict 編譯，不會被 vitest 當測試收集）。
// api-server 實際傳給 superviseRun 的就是這個型別：stdio 為 ['ignore','pipe','pipe'] 的 child process。
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { superviseRun } from '../../../scripts/lib/print-run';

export function compat(): Promise<unknown> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn('/bin/sh', ['-c', 'true'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return superviseRun(child, { timeoutMs: 1, killGraceMs: 1, hardDeadlineMs: 1, rawMaxBytes: 1, logMaxBytes: 1, scrub: (t) => t, writeLog: () => {} });
}
