import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// trip-planner#1627：舊入口（Pages /api/*）退役，agent 的 API base 預設一律是新 api。
const REPO_ROOT = resolve(__dirname, '../..');
const OLD_HOST = 'trip-planner-dby.pages.dev';
const NEW_API = 'https://trip-planner-api-production.lean-lean.workers.dev';

// 舊網域仍合法的出現處：它同時是 web 網站網域，不是 API base。逐檔限定「哪一行」，避免整檔放行。
const ALLOWLIST: { file: string; line: RegExp; reason: string }[] = [
  {
    file: 'scripts/daily-check.js',
    line: /var BASE = 'https:\/\/trip-planner-dby\.pages\.dev';/,
    reason: 'queryRouteHealth 探測 SPA 頁面（/、/manage/…）是否 < 500，探的是網站不是 API',
  },
  {
    file: 'scripts/daily-report.js',
    line: /var SITE_URL = process\.env\.SITE_URL \|\| 'https:\/\/trip-planner-dby\.pages\.dev';/,
    reason: 'SITE_URL 只給 PageSpeed 量測網站；打 API 改走 API_BASE',
  },
  {
    file: '.github/workflows/daily-report.yml',
    line: /SITE_URL: 'https:\/\/trip-planner-dby\.pages\.dev'/,
    reason: '同上，PageSpeed 的網站網址',
  },
  {
    file: 'README.md',
    line: /退役舊入口|探的是\*\*網站\*\*/,
    reason: '切換說明本身要點名舊網域（說明哪個是舊入口、哪個是網站）',
  },
];

function trackedHits(): { file: string; text: string }[] {
  const out = execFileSync(
    'git',
    ['grep', '-In', '-e', OLD_HOST, '--', 'scripts', '.claude', '.github', 'README.md', ':!CHANGELOG.md'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).toString();
  return out.split('\n').filter(Boolean).map((l) => {
    const [file, , ...rest] = l.split(':');
    return { file, text: rest.join(':') };
  });
}

describe('API base 預設值（舊入口退役）', () => {
  it('scripts/、.claude/skills、.github 不得再以舊入口網域作為 API base（allowlist 除外）', () => {
    const offenders = trackedHits().filter(
      (h) => !ALLOWLIST.some((a) => a.file === h.file && a.line.test(h.text)),
    );
    expect(offenders.map((h) => `${h.file}: ${h.text.trim()}`)).toEqual([]);
  });

  it('allowlist 每一條都還在用（防止清單腐爛）', () => {
    const hits = trackedHits();
    for (const a of ALLOWLIST) {
      expect(hits.some((h) => h.file === a.file && a.line.test(h.text)), `${a.file}（${a.reason}）`).toBe(true);
    }
  });

  it.each([
    'scripts/tripline-api-server.ts',
    'scripts/_lib/cron-shared.ts',
    'scripts/daily-check.js',
    'scripts/lib/get-tripline-token.js',
    'scripts/cleanup-test-data-leak.js',
    'scripts/tp-request-mcp-server.js',
    'scripts/tripline-job.sh',
  ])('%s 預設指向新 api', (file) => {
    expect(readFileSync(resolve(REPO_ROOT, file), 'utf8')).toContain(NEW_API);
  });
});
