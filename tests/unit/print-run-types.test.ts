import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * repo 的 tsconfig 只涵蓋 src/，scripts/ 從來沒被型別檢查過（bun 與 vitest 都只轉譯不檢查）。
 * print 模式這幾個模組會被 api-server 直接餵真的 child process，型別不合在執行期不會爆但代表契約對不上
 * （第三輪審查前就有一個 ChildProcess 的 stdout 可能為 null 的型別錯誤沒被發現），所以單獨用 tsc --strict 守住。
 */
describe('print 模式模組的型別（tsc --strict）', () => {
  it('print-run / request-worker / fail-pending / print-run-sweep 與 ChildProcess 相容性樣本都能通過 strict 編譯', () => {
    const r = spawnSync('npx', [
      'tsc', '--noEmit', '--ignoreConfig', '--skipLibCheck', '--strict', '--target', 'es2022', '--module', 'esnext',
      '--moduleResolution', 'bundler', '--types', 'node',
      'scripts/lib/print-run.ts', 'scripts/lib/request-worker.ts', 'scripts/lib/fail-pending-requests.ts',
      'scripts/lib/print-run-sweep.ts', 'tests/unit/fixtures/print-run-compat.ts',
    ], { encoding: 'utf-8', cwd: process.cwd() });
    expect(`${r.stdout}${r.stderr}`.replace(/^npm notice.*$/gm, '').trim()).toBe('');
    expect(r.status).toBe(0);
  }, 120_000);
});
