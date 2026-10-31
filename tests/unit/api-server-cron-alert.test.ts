/**
 * api-server cron alert regression — v2.33.127 PR4
 *
 * G3: detached spawn exit code 0 / non-0 wrapper + throttledAlert
 * G8: fireSchedule processLoop unhandled error → throttledAlert (對齊 /tp-request)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../scripts/tripline-api-server.ts'),
  'utf8',
);

describe('G3: fireScheduleScript exit code wrapper (detached spawn)', () => {
  it('import throttledAlert from cron-shared', () => {
    // 容許同行 co-import（v2.55.52 起加了 sleep）— 意圖只鎖 throttledAlert 來自 cron-shared。
    expect(SRC).toMatch(/import \{[^}]*\bthrottledAlert\b[^}]*\} from '\.\/_lib\/cron-shared'/);
  });

  it("child.on('exit') 必存在（之前完全沒檢查 exit code）", () => {
    expect(SRC).toMatch(/child\.on\('exit',\s*\(code,\s*signal\)/);
  });

  it('exit code 0 → throttledAlert healthy (recovery 自動 trigger)', () => {
    expect(SRC).toMatch(/code === 0/);
    expect(SRC).toMatch(/throttledAlert\(\s*`script-exit-\$\{label\}`,\s*'healthy'/);
  });

  it('exit code 非 0 → throttledAlert failed + 含 log 路徑指引', () => {
    expect(SRC).toMatch(/throttledAlert\(\s*`script-exit-\$\{label\}`,\s*'failed'/);
    expect(SRC).toMatch(/查 log：scripts\/logs\/script-\$\{label\}-/);
  });

  it("child.on('error') spawn error 也 throttledAlert", () => {
    expect(SRC).toMatch(/`script-spawn-\$\{label\}`,\s*'failed'/);
  });

  it('fireScheduleScript setup catch 路徑也 throttledAlert', () => {
    expect(SRC).toMatch(/`script-setup-\$\{label\}`,\s*'failed'/);
  });
});

describe('G8: fireSchedule processLoop unhandled → throttledAlert', () => {
  it('cron-${label} key + state=failed', () => {
    expect(SRC).toMatch(/`cron-\$\{label\}`,\s*'failed'/);
  });

  it('alert 含 skill + error 前 200 字 truncate', () => {
    expect(SRC).toMatch(/skill=\$\{skillCommand\}/);
    expect(SRC).toMatch(/errMsg\.slice\(0, 200\)/);
  });

  it('原 logError 保留（log + alert 雙寫）', () => {
    expect(SRC).toMatch(/logError\(`internal cron \$\{label\} processLoop unhandled:/);
  });
});

describe('regression：dedup key 命名一致', () => {
  it('throttledAlert key 都用 cron-/script-spawn-/script-exit-/script-setup-/mint- prefix', () => {
    // Option E（v2.55.62）：user token 換發改為 mint-restricted，失敗 alert key 由
    // usertoken-${kind} 改成 mint-${kind}。併入允許前綴集。
    const keys = Array.from(SRC.matchAll(/throttledAlert\(\s*`([^`]+)`/g)).map((m) => m[1]);
    for (const k of keys) {
      expect(k).toMatch(/^(cron|script-(spawn|exit|setup)|mint)-/);
    }
  });
});
