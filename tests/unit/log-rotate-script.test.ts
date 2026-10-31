/**
 * log-rotate.sh regression — v2.33.131 PR8 G13
 *
 * Source-grep + retention 政策 + api-server schedule wiring。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(__dirname, '../../scripts/log-rotate.sh'), 'utf8');
const SERVER = readFileSync(
  join(__dirname, '../../scripts/tripline-api-server.ts'),
  'utf8',
);

describe('log-rotate.sh — retention 政策', () => {
  it('LOG_RETENTION_DAYS = 30 (per-date files)', () => {
    expect(SCRIPT).toMatch(/LOG_RETENTION_DAYS=30/);
  });

  it('LOG_MAX_BYTES = 10MB (single-file general)', () => {
    expect(SCRIPT).toMatch(/LOG_MAX_BYTES=10485760/);
  });

  it('LOG_FUNNEL_CAP = 1MB (高頻 log tighter cap)', () => {
    expect(SCRIPT).toMatch(/LOG_FUNNEL_CAP=1048576/);
  });

  it('Rule 1: find -mtime +30 delete per-date files', () => {
    expect(SCRIPT).toMatch(/find "\$LOG_DIR" -type f \\\( -name '\*\.log' -o -name '\*\.err' \\\) -mtime "\+\$LOG_RETENTION_DAYS"/);
  });

  it('Rule 2: truncate oversized single-file logs → tail 50%', () => {
    expect(SCRIPT).toMatch(/truncate_if_large/);
    expect(SCRIPT).toMatch(/local keep=\$\(\(cap \/ 2\)\)/);
    expect(SCRIPT).toMatch(/tail -c "\$keep"/);
  });

  it('Rule 3: funnel-guard / api-server-stderr 走 1MB cap', () => {
    expect(SCRIPT).toMatch(/truncate_if_large "\$LOG_DIR\/api-server-stderr\.log" "\$LOG_FUNNEL_CAP"/);
    expect(SCRIPT).toMatch(/truncate_if_large "\$LOG_DIR\/funnel-guard\/stdout\.log" "\$LOG_FUNNEL_CAP"/);
  });

  it('set -eo pipefail (fail-fast + pipe-aware)', () => {
    expect(SCRIPT).toMatch(/^set -eo pipefail$/m);
  });

  it('summary log 含 deleted/truncated count（給 PR4 exit code wrapper alert）', () => {
    expect(SCRIPT).toMatch(/done — deleted=\$deleted_count truncated=\$truncated_count/);
  });
});

describe('api-server schedule wiring', () => {
  it('scheduleDailyScript 03:30 跑 log-rotate.sh', () => {
    expect(SERVER).toMatch(
      /scheduleDailyScript\(3, 30, 'zsh', \['scripts\/log-rotate\.sh'\], 'log-rotate'\)/,
    );
  });

  it('label="log-rotate" — PR4 throttledAlert key prefix 對齊', () => {
    // exit code alert 用 'script-exit-${label}' = 'script-exit-log-rotate'
    expect(SERVER).toMatch(/'log-rotate'/);
  });
});
