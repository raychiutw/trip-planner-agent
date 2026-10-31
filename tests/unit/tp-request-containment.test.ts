/**
 * tp-request containment — behavioural tests of the pure spawn builders
 * (scripts/lib/contained-spawn.ts). These lock the security invariants that make
 * layer A+B containment hold, by actual output inspection (not source-grep).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildContainedShellCommand,
  buildMcpConfig,
  shSingleQuote,
  TP_AGENT_USER,
  CONTAINED_PATH,
  PRINT_MAX_TURNS,
} from '../../scripts/lib/contained-spawn';

const BASE = {
  claudeBin: '/Users/ray/.local/bin/claude',
  skillCommand: '/tp-request',
  sessionDir: '/Users/tp-agent/.tripline-contained/tripline-tp-request-123-456',
  settingsPath: '/repo/scripts/tp-request-contained/settings.json',
  mcpConfigPath: '/Users/tp-agent/.tripline-contained/tripline-tp-request-123-456/mcp-config.json',
  tokenFilePath: '/Users/tp-agent/.tripline-contained/tripline-tp-request-123-456/oauth-token',
};
const TOKEN = 'restrict-tok-SECRET-abc123';

describe('buildContainedShellCommand — layer A (OS isolation + env scrub)', () => {
  it('runs as tp-agent via non-interactive sudo', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).toContain(`sudo -n -u ${TP_AGENT_USER} `);
  });

  it('scrubs the environment with env -i and sets only safe vars', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).toContain('env -i ');
    expect(cmd).toContain(`PATH='${CONTAINED_PATH}'`);
    expect(cmd).toContain(`HOME='/Users/${TP_AGENT_USER}'`);
    expect(cmd).toContain('TMPDIR=');
    expect(cmd).toContain('CLAUDE_CONFIG_DIR=');
    // no ambient secret var names leak into the scrubbed env
    expect(cmd).not.toMatch(/CLIENT_SECRET|REFRESH|\.env\.local/i);
  });
});

describe('buildContainedShellCommand — layer B (capability lockdown)', () => {
  it('uses dontAsk + isolated --settings + --mcp-config + --strict-mcp-config', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).toContain('--permission-mode dontAsk');
    // flags live in the sh wrapper; the actual paths are positional args ($4/$5)
    expect(cmd).toContain('--settings "$4"');
    expect(cmd).toContain('--mcp-config "$5"');
    expect(cmd).toContain('--strict-mcp-config'); // tripline is provably the whole tool surface
    expect(cmd).toContain(`'${BASE.settingsPath}'`);
    expect(cmd).toContain(`'${BASE.mcpConfigPath}'`);
  });

  it('cd into the session dir first (so the clean session dir is the trusted workspace, not the repo)', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).toContain('cd "$1"'); // cwd = session dir, set inside the wrapper (as tp-agent)
    expect(cmd).toContain(`'${BASE.sessionDir}'`); // session dir passed as $1
  });

  it('headless claude -p <skill>：skill 是 $6、有輪數上限、沒有 --name（不再是互動式 REPL）', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).toContain('/bin/sh -c'); // launched through the OAuth sh wrapper
    expect(cmd).toContain('-p "$6"');
    expect(cmd).toContain(`--max-turns ${PRINT_MAX_TURNS}`); // 被注入的訊息不能無上限燒計費的 tool call
    expect(cmd).not.toContain('--name');
    expect(cmd.trimEnd().endsWith(`'/tp-request'`)).toBe(true);
  });

  it('NEVER passes --dangerously-skip-permissions / bypassPermissions (would void the allowlist)', () => {
    const cmd = buildContainedShellCommand(BASE);
    expect(cmd).not.toContain('--dangerously-skip-permissions');
    expect(cmd).not.toContain('bypassPermissions');
  });
});

describe('buildContainedShellCommand — neither token on the command line', () => {
  it('restrict API token + OAuth token absent from argv; only their 0600 FILE paths appear', () => {
    const cmd = buildContainedShellCommand(BASE);
    // restrict API token: not even an input to the builder (lives in the mcp-config file)
    expect(cmd).not.toContain(TOKEN);
    expect(cmd).not.toMatch(/TRIPLINE_API_TOKEN/);
    // OAuth token: read from the 0600 file into the env by the sh wrapper — never argv
    expect(cmd).toContain('CLAUDE_CODE_OAUTH_TOKEN=$(cat "$2")');
    expect(cmd).toContain(`'${BASE.tokenFilePath}'`);
    // its value is never inlined as an env assignment on the command
    expect(cmd).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN=[A-Za-z0-9]/);
  });
});

describe('buildContainedShellCommand — shell-injection safety', () => {
  it('single-quotes every interpolated value; a malicious skill command cannot break out', () => {
    const evil = "x'; rm -rf ~; echo '";
    const cmd = buildContainedShellCommand({ ...BASE, skillCommand: evil });
    // escaping applied: each ' becomes '\'' so the value stays inside its single quotes
    expect(cmd).toContain(shSingleQuote(evil));
    // the raw breakout (bare quote immediately closing then `;`) is neutralised
    expect(cmd).not.toContain("x';");
  });
});

describe('buildMcpConfig — token delivery via server env (not inherited)', () => {
  it('embeds the restrict token + trip in the tripline server env block', () => {
    const cfg = JSON.parse(buildMcpConfig({
      nodeBin: '/opt/homebrew/bin/node',
      mcpServerPath: '/repo/scripts/tp-request-mcp-server.js',
      token: TOKEN,
      restrictTrip: 'trip-XYZ',
    }));
    const server = cfg.mcpServers.tripline;
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('/opt/homebrew/bin/node');
    expect(server.args).toEqual(['/repo/scripts/tp-request-mcp-server.js']);
    expect(server.env.TRIPLINE_API_TOKEN).toBe(TOKEN);
    expect(server.env.TRIPLINE_RESTRICT_TRIP).toBe('trip-XYZ');
  });

  it('exposes only the tripline server (no other MCP servers)', () => {
    const cfg = JSON.parse(buildMcpConfig({ nodeBin: 'node', mcpServerPath: 's.js', token: 't', restrictTrip: 'r' }));
    expect(Object.keys(cfg.mcpServers)).toEqual(['tripline']);
  });
});

/*
 * 2026-07-29 prod 事故：contained session 啟動時報「I don't have any
 * mcp__tripline__* tools」，整個 session 廢掉（緊急聯絡生成 job 19 因此 timed_out）。
 *
 * MCP server 本身沒問題（單獨跑 tools/list 回 15 個工具）。病灶是
 * MCP_SERVER_PATH 指向 **repo 工作區**，而 session spawn 那一刻我正在對工作區
 * 做 git pull / 切分支。claude 只在啟動時載一次 MCP server —— 那一瞬間的檔案狀態
 * 決定整個 session 的命運，之後工作區恢復也救不回來。
 *
 * 修法：spawn 時把 MCP server 快照進 session 專屬目錄（它零 require、380 行完全
 * 自足），設定指向那份快照。工作區之後怎麼動都影響不到已啟動的 session。
 */
describe('MCP server 路徑必須是 session 內的快照，不是共用工作區', () => {
  it('buildMcpConfig 接受並原樣使用傳入的 mcpServerPath', () => {
    const snapshot = `${BASE.sessionDir}/tp-request-mcp-server.js`;
    const cfg = JSON.parse(buildMcpConfig({
      nodeBin: '/opt/homebrew/bin/node',
      mcpServerPath: snapshot,
      token: 'tok',
      restrictTrip: 'trip-x',
    }));
    expect(cfg.mcpServers.tripline.args).toEqual([snapshot]);
  });

  it('api-server 把 MCP server 複製進 session 目錄後才建設定', () => {
    const src = readFileSync(
      join(__dirname, '../../scripts/tripline-api-server.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    // 設定必須指向 session 內的快照路徑，不能直接用 MCP_SERVER_PATH
    expect(src).toMatch(/mcpServerPath:\s*mcpServerSnapshotPath/);
    // 快照本身要被寫進去（跟 mcp-config / oauth-token 同一批 0600 寫入）
    expect(src).toContain('mcpServerSnapshotPath');
    expect(src).toMatch(/readFileSync\(MCP_SERVER_PATH/);
  });
});
