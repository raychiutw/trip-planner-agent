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
  existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const DEPLOY = join(REPO, 'scripts/deploy.sh');

let runtime: string;
let agents: string;

function deploy() {
  execFileSync('/bin/zsh', [DEPLOY], {
    env: {
      ...process.env,
      RUNTIME_DIR: runtime,
      LAUNCH_AGENTS_DIR: agents,
      DEPLOY_REF: 'HEAD',
      NO_FETCH: '1',
      NO_LAUNCHCTL: '1',
      SKIP_INSTALL: '1',
    },
    stdio: 'pipe',
  });
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'tripline-deploy-'));
  runtime = join(base, 'runtime');
  agents = join(base, 'agents');
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
});
