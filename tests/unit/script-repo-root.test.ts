/**
 * 腳本的 repo 根目錄由腳本自己的位置推導，不寫死 /Users/ray/...（ops runtime module）。
 *
 * 做法：取出腳本裡 REPO_ROOT／PROJECT_DIR 的那一行賦值，在 zsh 裡以「腳本在別處」的 $0 執行，
 * 看結果是不是跟著搬家。寫死的路徑會回傳原本的 /Users/ray/...。
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS: Array<{ file: string; varName: string }> = [
  { file: 'scripts/log-rotate.sh', varName: 'REPO_ROOT' },
  { file: 'scripts/tripline-job.sh', varName: 'PROJECT_DIR' },
];

// 這些腳本是 zsh（launchd／macOS 專用）；GitHub 的 Ubuntu runner 沒有 zsh，spawn 會得到 status null。
// 沒有 zsh 就明確跳過，而不是在 CI 假紅；本機（macOS）會真的執行。
const HAS_ZSH = spawnSync('zsh', ['-c', 'true']).status === 0;

describe.skipIf(!HAS_ZSH).each(SCRIPTS)('$file', ({ file, varName }) => {
  it(`${varName} 跟著腳本所在的 checkout 走`, () => {
    const src = readFileSync(join(__dirname, '../..', file), 'utf8');
    const line = src.split('\n').find((l) => new RegExp(`^${varName}=`).test(l));
    expect(line, `${file} 找不到 ${varName}= 那一行`).toBeTruthy();

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'moved-checkout-')));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      const r = spawnSync('zsh', ['-c', `${line}\nprintf %s "$${varName}"`, join(root, file)], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scripts/_lib/cron-shared.ts loadCronEnv', () => {
  it('讀 REPO_ROOT 的 .env.local，不依賴 process.cwd()（從別的目錄執行才不會靜默拿到空憑證）', () => {
    const src = readFileSync(join(__dirname, '../../scripts/_lib/cron-shared.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = src.slice(src.indexOf('export function loadCronEnv'));
    expect(fn).toMatch(/envLoader\.REPO_ROOT/);
    expect(fn.slice(0, fn.indexOf('\n}\n'))).not.toMatch(/process\.cwd\(\)/);
  });
});
