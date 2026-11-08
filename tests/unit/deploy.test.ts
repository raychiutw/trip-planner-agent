/**
 * deploy.sh — launchd 只跑 ~/.tripline-agent 的複製，不跑 git 工作目錄
 *
 * 動機：plist 以前 symlink 回 repo、直接跑工作目錄，切 branch 就改變線上行為
 * （2026-11-07 guard 跑到 feature branch）。部署目標與 LaunchAgents 目錄都用環境變數
 * 指到暫存區，NO_LAUNCHCTL 不碰真的 launchd。部署來源是 DEPLOY_REF=HEAD 的 commit。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, readlinkSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const DEPLOY = join(REPO, 'scripts/deploy.sh');

let runtime: string;
let agents: string;
let claudeJson: string;

function deploy() {
  // umask 077：預設 umask 下 tar 解出來本來就可讀，測不出 chmod 有沒有作用
  execFileSync('/bin/sh', ['-c', 'umask 077; exec /bin/zsh "$1"', '_', DEPLOY], {
    env: {
      ...process.env,
      RUNTIME_DIR: runtime,
      LAUNCH_AGENTS_DIR: agents,
      DEPLOY_REF: 'HEAD',
      NO_FETCH: '1',
      NO_LAUNCHCTL: '1',
      SKIP_INSTALL: '1',
      CLAUDE_CONFIG_FILE: claudeJson,   // 永遠指到暫存檔，測試不碰真的 ~/.claude.json
    },
    stdio: 'pipe',
  });
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'tripline-deploy-'));
  runtime = join(base, 'runtime');
  agents = join(base, 'agents');
  claudeJson = join(base, 'claude.json');
  mkdirSync(agents);
});

describe('deploy.sh', () => {
  it('把 committed 的程式複製到 app/，不帶 tests／.github／.git', () => {
    deploy();
    expect(existsSync(join(runtime, 'app/scripts/funnel-guard/guard.sh'))).toBe(true);
    expect(existsSync(join(runtime, 'app/scripts/tripline-api-server.ts'))).toBe(true);
    expect(existsSync(join(runtime, 'app/tests'))).toBe(false);
    expect(existsSync(join(runtime, 'app/.github'))).toBe(false);
    expect(existsSync(join(runtime, 'app/.git'))).toBe(false);
  });

  it('plist 是複製（不是 symlink 回 repo），且路徑全指向執行目錄', () => {
    deploy();
    for (const job of ['com.tripline.api-server', 'com.tripline.funnel-guard']) {
      const p = join(agents, `${job}.plist`);
      expect(lstatSync(p).isSymbolicLink()).toBe(false);
      const xml = readFileSync(p, 'utf8');
      expect(xml).toContain(runtime);
      expect(xml).not.toContain('Projects/trip-planner-agent');
      expect(xml).not.toContain('__RUNTIME__');
    }
  });

  it('既有的 symlink plist 會被取代，不會寫穿回 repo 的範本', () => {
    const tpl = join(REPO, 'scripts/com.tripline.funnel-guard.plist');
    const before = readFileSync(tpl, 'utf8');
    // 模擬舊的 install.sh：LaunchAgents 裡是指回 repo 的 symlink
    execFileSync('ln', ['-s', tpl, join(agents, 'com.tripline.funnel-guard.plist')]);
    deploy();
    expect(lstatSync(join(agents, 'com.tripline.funnel-guard.plist')).isSymbolicLink()).toBe(false);
    expect(readFileSync(tpl, 'utf8')).toBe(before);
  });

  it('.env.local 與 logs 在執行目錄擁有，不被再次部署覆蓋或刪除', () => {
    deploy();
    writeFileSync(join(runtime, '.env.local'), 'TELEGRAM_BOT_TOKEN=keep-me\n');
    mkdirSync(join(runtime, 'app/scripts/funnel-guard'), { recursive: true });
    writeFileSync(join(runtime, 'app/scripts/funnel-guard/.disabled'), '');
    writeFileSync(join(runtime, 'logs/marker.log'), 'x');
    deploy();
    expect(readFileSync(join(runtime, '.env.local'), 'utf8')).toContain('keep-me');
    expect(readlinkSync(join(runtime, 'app/.env.local'))).toBe('../.env.local');
    expect(readlinkSync(join(runtime, 'app/scripts/logs'))).toBe('../../logs');
    expect(existsSync(join(runtime, 'app/scripts/funnel-guard/.disabled'))).toBe(true);
    expect(existsSync(join(runtime, 'logs/marker.log'))).toBe(true);
  });

  it('repo 裡拿掉的檔案，部署後也從執行目錄消失', () => {
    deploy();
    writeFileSync(join(runtime, 'app/scripts/stale-leftover.sh'), '#!/bin/sh\n');
    deploy();
    expect(existsSync(join(runtime, 'app/scripts/stale-leftover.sh'))).toBe(false);
  });

  it('api-server 需要的 .claude/skills 也部署過去（contained session 從 PROJECT_DIR/.claude/skills 連結）', () => {
    deploy();
    expect(existsSync(join(runtime, 'app/.claude/skills/tp-request/SKILL.md'))).toBe(true);
  });

  it('app 對 other 唯讀可進入（tp-agent 要讀 skill 與 MCP server），但 .env.local 仍是 600', () => {
    deploy();
    writeFileSync(join(runtime, '.env.local'), 'X=1\n');   // 預設 umask 644，部署要把它收成 600
    deploy();
    expect(statSync(join(runtime, 'app/scripts/tp-request-mcp-server.js')).mode & 0o004).toBe(0o004);
    expect(statSync(join(runtime, 'app/scripts')).mode & 0o005).toBe(0o005);   // 目錄要能進入
    // app 根目錄 rsync 會帶上暫存目錄的 700：tp-agent 屬 staff 群組，group 位元是 --- 就會被擋在外面（other 不會被看）
    expect(statSync(join(runtime, 'app')).mode & 0o055).toBe(0o055);
    expect(statSync(runtime).mode & 0o001).toBe(0o001);
    expect(statSync(join(runtime, '.env.local')).mode & 0o777).toBe(0o600);
  });
});

describe('deploy.sh — Claude Code 對執行目錄的信任', () => {
  // Claude Code 對沒開過的資料夾會先跳「信任這個資料夾？」，吃掉 api-server 送進 tmux session 的 skill 指令
  //（2026-11-08 06:10 daily-check 因此失敗：「REPL 未接到輸入」）。執行目錄是新路徑時沒有信任紀錄，部署要補上。
  const trusted = () => JSON.parse(readFileSync(claudeJson, 'utf8')).projects?.[join(runtime, 'app')];

  it('設定檔存在 → 補上 app 目錄的信任，其他設定原封不動', () => {
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 7, projects: { '/other/repo': { hasTrustDialogAccepted: true, x: 1 } } }));
    deploy();
    expect(trusted()?.hasTrustDialogAccepted).toBe(true);
    const cfg = JSON.parse(readFileSync(claudeJson, 'utf8'));
    expect(cfg.numStartups).toBe(7);
    expect(cfg.projects['/other/repo']).toEqual({ hasTrustDialogAccepted: true, x: 1 });
  });

  it('該目錄已有其他紀錄 → 只改信任旗標，保留其餘欄位', () => {
    deploy();   // 先建好 runtime 路徑
    writeFileSync(claudeJson, JSON.stringify({ projects: { [join(runtime, 'app')]: { hasTrustDialogAccepted: false, allowedTools: ['Bash'] } } }));
    deploy();
    expect(trusted()).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
  });

  it('已經信任 → 不改寫檔案（執行中的 Claude 也會寫這個檔，能不碰就不碰）', () => {
    deploy();
    writeFileSync(claudeJson, JSON.stringify({ projects: { [join(runtime, 'app')]: { hasTrustDialogAccepted: true } } }, null, 4));
    const before = statSync(claudeJson).mtimeMs;
    const bytes = readFileSync(claudeJson, 'utf8');
    deploy();
    expect(readFileSync(claudeJson, 'utf8')).toBe(bytes);
    expect(statSync(claudeJson).mtimeMs).toBe(before);
  });

  it('保留設定檔原本的權限', () => {
    // 用 0640：deploy 在 umask 077 下跑，新檔預設就是 0600，用 0600 測不出有沒有保留
    writeFileSync(claudeJson, '{}');
    chmodSync(claudeJson, 0o640);
    deploy();
    expect(statSync(claudeJson).mode & 0o777).toBe(0o640);
    expect(trusted()?.hasTrustDialogAccepted).toBe(true);
  });

  it('設定檔不存在 → 部署照常成功，也不憑空建立', () => {
    deploy();
    expect(existsSync(claudeJson)).toBe(false);
    expect(existsSync(join(runtime, 'app/scripts/tripline-api-server.ts'))).toBe(true);
  });

  it('設定檔壞掉（不是 JSON）→ 部署不中止，檔案原樣保留', () => {
    writeFileSync(claudeJson, '{ not json');
    deploy();
    expect(readFileSync(claudeJson, 'utf8')).toBe('{ not json');
    expect(existsSync(join(runtime, 'app/scripts/tripline-api-server.ts'))).toBe(true);
  });
});

describe('throttled-alert.sh', () => {
  it('send-telegram 預設路徑跟著 REPO_ROOT，不寫死 repo 位置', () => {
    const src = readFileSync(join(REPO, 'scripts/lib/throttled-alert.sh'), 'utf8');
    expect(src).not.toContain('/Users/ray/Projects/trip-planner-agent');
    const out = execFileSync(
      '/bin/zsh',
      ['-c', 'REPO_ROOT=/opt/x source "$1"; printf %s "$THROTTLED_ALERT_SEND_TELEGRAM"', '_',
        join(REPO, 'scripts/lib/throttled-alert.sh')],
      { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
    );
    expect(out).toBe('/opt/x/scripts/lib/send-telegram.sh');
  });
});
