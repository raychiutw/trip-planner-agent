#!/usr/bin/env bun
/**
 * Tripline API Server — Mac Mini 上的請求處理服務
 *
 * D1 是唯一的佇列。收到 trigger 後從 CF API 撈 open 請求依序處理。
 * 用 Bun HTTP server 監聽 port 6688，Caddy 反向代理 Tailscale Funnel。
 *
 * Endpoints:
 *   POST /trigger?source=api|job  — 啟動處理迴圈
 *   GET  /health                  — 健康檢查
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import nodemailer, { type Transporter } from 'nodemailer';
import { makeMailHandler } from './lib/mailer-handler';
import { computeNextDailyFire } from './lib/schedule-daily';
import type { TmuxDeps } from './lib/tmux-pane';
import {
  TP_AGENT_USER,
  shSingleQuote,
  buildContainedShellCommand,
  buildMcpConfig,
} from './lib/contained-spawn';
import { throttledAlert, sleep } from './_lib/cron-shared';
import { createRequestWorker, type PrintRunResult } from './lib/request-worker';
import { sweepStalePrintRuns } from './lib/print-run-sweep';
import {
  superviseRun, PRINT_RUN_TIMEOUT_MS, PRINT_KILL_GRACE_MS, PRINT_HARD_DEADLINE_MS, PRINT_LOG_MAX_BYTES, PRINT_RAW_MAX_BYTES,
} from './lib/print-run';
import envLoader from './lib/load-env.js';

// --- Load .env.local ---
// 全 repo 唯一的 parser：scripts/lib/load-env.js（已存在的 env 優先、不覆蓋）。
envLoader.loadEnvLocal();

// --- Config ---
const PORT = parseInt(process.env.TRIPLINE_PORT || '6688', 10);
const API_SECRET = process.env.TRIPLINE_API_SECRET || '';
const PROJECT_DIR = process.env.PROJECT_DIR || join(import.meta.dir, '..');
const LOG_DIR = join(PROJECT_DIR, 'scripts', 'logs', 'api-server');
const TOKEN_HELPER = join(PROJECT_DIR, 'scripts', 'lib', 'get-tripline-token.js');
// v2.55.56: prod API base — peek pending requests + downscope the user token to one trip.
const API_BASE = process.env.TRIPLINE_API_BASE || 'https://trip-planner-dby.pages.dev';

// --- Mailer config (Gmail SMTP) ---
const GMAIL_USER = process.env.GMAIL_USERNAME || '';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || '';
const EMAIL_FROM_DEFAULT = process.env.EMAIL_FROM || `Tripline <${GMAIL_USER}>`;

// --- Logging ---
mkdirSync(LOG_DIR, { recursive: true });

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(join(LOG_DIR, `${todayStr()}.log`), line); } catch {}
}

function logError(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [error] ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(join(LOG_DIR, `${todayStr()}.log`), line); } catch {}
  try { appendFileSync(join(LOG_DIR, `${todayStr()}.error.log`), line); } catch {}
}

// --- Token helper ---
// v2.30.7: API server 只用 token helper 一次（mint 後 inject 到 tmux session env）。
// queue drain + PATCH status 改由 /tp-request skill 自己做（curl + load-env.mjs）。
const tokenHelper = require(TOKEN_HELPER) as {
  getToken: (opts?: { forceFresh?: boolean }) => Promise<string>;
  invalidateCache: () => void;
};
const TMUX_BIN = (() => {
  const candidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
  for (const p of candidates) {
    try {
      if (require('fs').existsSync(p)) return p;
    } catch {}
  }
  return 'tmux'; // fallback — let spawnSync resolve via PATH
})();

// Phase 2 cron PATH 修：launchd PATH 不含 /opt/homebrew/bin，且 google-poi-refresh 舊
// hardcode /Users/ray/.bun/bin/bun 已不存在（bun 移到 homebrew）、auth-cleanup 用裸 'node'
// → 兩者 spawn ENOENT 沒在跑（api-server-stderr 2026-06-14/15）。仿 TMUX_BIN 偵測絕對路徑。
const resolveBin = (candidates: string[], fallback: string): string => {
  for (const p of candidates) {
    try { if (require('fs').existsSync(p)) return p; } catch {}
  }
  return fallback;
};
const NODE_BIN = resolveBin(['/opt/homebrew/bin/node', '/usr/local/bin/node'], 'node');
const BUN_BIN = resolveBin(['/opt/homebrew/bin/bun', '/Users/ray/.bun/bin/bun'], 'bun');
const CLAUDE_BIN = '/Users/ray/.local/bin/claude';

// --- tp-request containment (activation precondition 0) ---
// When /tp-request runs with a restrict_trip *user* token (write-capable), the
// session is doubly-contained: layer B = Claude Code dontAsk + only mcp__tripline__*
// (scripts/tp-request-contained/settings.json); layer A = separate unix user
// `tp-agent` + scrubbed env. See scripts/tp-request-contained/README.md, incl. the
// Ray-manual (0a) precondition. Until (0a) is done, containmentReady() is false and
// a restrict-token request FAILS CLOSED to a read-only service token (never runs the
// write-capable token un-contained).
// TP_AGENT_USER / CONTAINED_PATH / shSingleQuote / build* → ./lib/contained-spawn (pure, tested)
const CONTAINED_SETTINGS_PATH = join(PROJECT_DIR, 'scripts', 'tp-request-contained', 'settings.json');
const MCP_SERVER_PATH = join(PROJECT_DIR, 'scripts', 'tp-request-mcp-server.js');
const CONTAINED_BASE_DIR = `/Users/${TP_AGENT_USER}/.tripline-contained`;
const tmuxDeps: TmuxDeps = {
  capture: (s) => spawnSync(TMUX_BIN, ['capture-pane', '-t', s, '-p'], { encoding: 'utf-8' }).stdout || '',
  sendKeys: (s, keys) => { spawnSync(TMUX_BIN, ['send-keys', '-t', s, keys], { encoding: 'utf-8' }); },
  sleep,
  log,
};

// --- tp-request containment helpers ---

const RUN_AS_AGENT_TIMEOUT_MS = 30_000;

/** Run a command AS the tp-agent user (non-interactive sudo; needs (0a) NOPASSWD). */
function runAsAgent(args: string[], input?: string) {
  // timeout：spawnSync 會凍住整個 event loop（連 /health 都不回，也卡住逾時計時器），sudo／磁碟卡住不能無限等。
  return spawnSync('sudo', ['-n', '-u', TP_AGENT_USER, ...args], { encoding: 'utf-8', input, timeout: RUN_AS_AGENT_TIMEOUT_MS });
}

/** Is the containment infra ready to run a write-capable token safely?
 *  Requires the settings + MCP server files AND a working passwordless sudo to
 *  tp-agent ((0a)). False → caller must fail closed (never run the restrict token
 *  un-contained). */
function containmentReady(): boolean {
  try {
    // Contained claude runs as a non-login user with NO keychain, so subscription
    // OAuth (/login) can't persist. It authenticates via CLAUDE_CODE_OAUTH_TOKEN
    // (from `claude setup-token`, put in .env.local). Missing → can't run → fail closed.
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      logError('containment: 缺 CLAUDE_CODE_OAUTH_TOKEN（跑 `claude setup-token` 貼進 .env.local）— fail-closed');
      return false;
    }
    if (!existsSync(CONTAINED_SETTINGS_PATH) || !existsSync(MCP_SERVER_PATH)) return false;
    if (runAsAgent(['true']).status !== 0) return false;
    // NEGATIVE self-probe: tp-agent must NOT be able to read ray's creds. Catches a
    // botched (0a) chmod that leaves FS isolation porous → fail closed. `test -r`
    // is 0 only when readable (also non-0 when the path is absent — fine).
    for (const p of [join(PROJECT_DIR, '.env.local'), '/Users/ray/.tripline']) {
      if (runAsAgent(['test', '-r', p]).status === 0) {
        logError(`containment self-probe FAILED：tp-agent 可讀 ${p} — FS 隔離未生效，fail-closed（修 (0a) chmod）`);
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
/** 佈置 per-run 隔離目錄；失敗一律 fail-closed 回 null。 */
function prepareContainedSessionDir(
  sessionName: string,
  token: string,
  restrictTrip: string,
): { sessionDir: string; mcpConfigPath: string; tokenFilePath: string } | null {
  const sessionDir = `${CONTAINED_BASE_DIR}/${sessionName}`;
  const mcpConfigPath = `${sessionDir}/mcp-config.json`;
  const tokenFilePath = `${sessionDir}/oauth-token`;

  // 1. per-session dirs, created AS tp-agent, 0700.
  for (const d of [sessionDir, `${sessionDir}/config`, `${sessionDir}/tmp`]) {
    const mk = runAsAgent(['mkdir', '-p', '-m', '700', d]);
    if (mk.status !== 0) {
      logError(`contained: mkdir ${d} 失敗（fail-closed）：${mk.stderr || mk.status}`);
      return null;
    }
  }

  // 2. write 0600 files AS tp-agent via stdin (never argv, so neither token hits `ps`):
  //    the mcp-config (restrict API token + trip) and the CLAUDE_CODE_OAUTH_TOKEN.
  const WRITER =
    "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],d,{mode:0o600}))";
  // MCP server **快照進 session 目錄**，設定指向快照而非 repo 工作區。
  //
  // 2026-07-29 事故：session 啟動時報「I don't have any mcp__tripline__* tools」，
  // 整個 session 廢掉（緊急聯絡生成因此 timed_out）。MCP server 本身沒問題 ——
  // 病灶是原本 mcpServerPath 直指 PROJECT_DIR，而 spawn 那一刻工作區正在被
  // git pull / 切分支改動。claude 只在啟動時載一次 MCP server，那一瞬間的檔案
  // 狀態決定整個 session 的命運，工作區之後恢復也救不回來。
  //
  // 這支腳本零 require、380 行完全自足，複製一份成本可忽略。
  const mcpServerSnapshotPath = `${sessionDir}/tp-request-mcp-server.js`;
  const mcpServerSource = readFileSync(MCP_SERVER_PATH, 'utf-8');
  const mcpConfig = buildMcpConfig({ nodeBin: NODE_BIN, mcpServerPath: mcpServerSnapshotPath, token, restrictTrip });
  // Pre-seed claude config so `claude -p` starts straight away for an
  // unattended service account: skip first-run onboarding (hasCompletedOnboarding) AND
  // pre-trust the (empty, allow-free) session dir (hasTrustDialogAccepted) so no
  // workspace-trust dialog blocks it. cwd is the session dir (see buildContainedShellCommand's
  // `cd "$1"`), which has no settings.local.json → trusting it grants nothing; the repo's
  // allow-entries are never in play. Verified live in the activation (0b) dry-run.
  const claudeJson = JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: { [sessionDir]: { hasTrustDialogAccepted: true } },
  });
  const files: Array<[string, string, string]> = [
    [mcpServerSnapshotPath, mcpServerSource, 'mcp-server-snapshot'],
    [mcpConfigPath, mcpConfig, 'mcp-config'],
    [tokenFilePath, process.env.CLAUDE_CODE_OAUTH_TOKEN || '', 'oauth-token'],
    [`${sessionDir}/config/.claude.json`, claudeJson, 'claude-json'],
  ];
  for (const [path, content, label] of files) {
    const w = runAsAgent([NODE_BIN, '-e', WRITER, path], content);
    if (w.status !== 0) {
      logError(`contained: 寫 ${label} 失敗（fail-closed）：${w.stderr || w.status}`);
      return null;
    }
  }

  // skill discovery: symlink the repo's skills into the disposable config dir (user-skill
  // scope) so `/tp-request` resolves WITHOUT making the repo the workspace/cwd.
  const skillsLink = runAsAgent(['ln', '-sfn', join(PROJECT_DIR, '.claude', 'skills'), `${sessionDir}/config/skills`]);
  if (skillsLink.status !== 0) {
    logError(`contained: skills symlink 失敗（fail-closed）：${skillsLink.stderr || skillsLink.status}`);
    return null;
  }

  return { sessionDir, mcpConfigPath, tokenFilePath };
}

/** 殺掉命令列帶有該 run 目錄的 tp-agent process（claude／MCP 子程序）；對 sudo 包裝層的 EPERM 噪音可忽略，它會隨子程序結束。 */
function killRunProcesses(sessionDir: string): void {
  // pkill -f 的樣式是未錨定的 regex：路徑裡的 `.` 要跳脫，結尾要錨定，否則 `…-123-45` 會連帶命中 `…-123-456`。
  const escaped = sessionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  runAsAgent(['pkill', '-KILL', '-f', '--', `${escaped}(/|$| )`]);
}

/**
 * contained `/tp-request` 的唯一執行路徑：`claude -p`（headless、跑完 process 就結束）。輸出脫敏後寫進 scripts/logs/tp-request/<runName>.log；結束後清掉 session 目錄（含 token 檔）。
 */
async function runContainedPrint(
  runName: string,
  skillCommand: string,
  token: string,
  restrictTrip: string,
): Promise<PrintRunResult> {
  const sessionDir = `${CONTAINED_BASE_DIR}/${runName}`;
  try {
    // 佈置與 spawn 階段的任何例外（例如 git pull 窗口讀不到 MCP server 檔）＝ claude 根本沒開始處理：
    // 回 started:false 讓 worker 不收屍；往上拋會被當成「處理失敗」而把使用者請求標成 failed。
    // 清理放在外層 finally：prepare 寫到一半失敗也會留下已寫好的 token 檔。
    let child: ChildProcessByStdio<null, Readable, Readable>;
    let logFile: string;
    try {
      const prepared = prepareContainedSessionDir(runName, token, restrictTrip);
      if (!prepared) return { ok: false, timedOut: false, started: false };
      const cmd = buildContainedShellCommand({
        claudeBin: CLAUDE_BIN, sessionDir: prepared.sessionDir,
        settingsPath: CONTAINED_SETTINGS_PATH, mcpConfigPath: prepared.mcpConfigPath,
        tokenFilePath: prepared.tokenFilePath, skillCommand,
      });
      const logDir = join(PROJECT_DIR, 'scripts', 'logs', skillCommand.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '-'));
      // log 只是輔助：目錄建不起來不能讓整輪失敗；寫檔本身也是 best-effort。
      try { mkdirSync(logDir, { recursive: true }); } catch { /* best-effort log */ }
      logFile = join(logDir, `${runName}.log`);
      child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      logError(`contained print 啟動前失敗（不收屍，留給下一個 tick）：${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, timedOut: false, started: false };
    }
    // 精確字串（這次的 restrict token、OAuth token）+ 通用格式；restrict token 是不透明字串，regex 抓不到。
    const secrets = [token, process.env.CLAUDE_CODE_OAUTH_TOKEN || ''].filter((v) => v.length >= 8);
    const scrub = (t: string) => secrets
      .reduce((acc, sec) => acc.split(sec).join('<redacted>'), t)
      .replace(/[Bb]earer [A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>');
    return await superviseRun(child, {
      timeoutMs: PRINT_RUN_TIMEOUT_MS, killGraceMs: PRINT_KILL_GRACE_MS, hardDeadlineMs: PRINT_HARD_DEADLINE_MS,
      rawMaxBytes: PRINT_RAW_MAX_BYTES, logMaxBytes: PRINT_LOG_MAX_BYTES,
      scrub,
      writeLog: (text) => appendFileSync(logFile, text, { mode: 0o600 }),
      onSpawnError: (err) => logError(`contained print child error：${err.message}`),
    });
  } finally {
    // 殘留的 claude／MCP 子程序（指令列帶有這一輪的 session 目錄）一併清掉，避免帶著 restrict token 繼續動行程。
    killRunProcesses(sessionDir);
    const rm = runAsAgent(['rm', '-rf', sessionDir]);
    if (rm.status !== 0) {
      const msg = `contained print: 清 session 目錄失敗（token 檔可能殘留，下次 api-server 啟動會補清）${sessionDir}：${rm.stderr || rm.status}`;
      logError(msg);
      void throttledAlert('print-run-cleanup-failed', 'failed', msg);
    }
  }
}

/** best-effort: pipe session output to a scrubbed persistent log (shared by both paths). */
function attachSessionLog(sessionName: string, skillCommand: string): void {
  try {
    const skillSlug = skillCommand.replace(/^\//, '').replace(/[^a-zA-Z0-9-]/g, '-');
    const sessionLogDir = join(PROJECT_DIR, 'scripts', 'logs', skillSlug);
    mkdirSync(sessionLogDir, { recursive: true });
    const pipe = spawnSync(TMUX_BIN, [
      'pipe-pane', '-t', sessionName, '-o',
      `sed -E 's#[Bb]earer [A-Za-z0-9._~+/=-]+#Bearer <redacted>#g' >> '${join(sessionLogDir, `${sessionName}.log`)}'`,
    ], { encoding: 'utf-8' });
    if (pipe.status !== 0) logError(`tmux pipe-pane failed (non-blocking): ${pipe.stderr || ''}`);
  } catch (err) {
    logError(`session log pipe setup failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }
}
/**
 * #1264：worker 決策（peek → token → busy → spawn）在 scripts/lib/request-worker.ts，
 * 這裡只組裝真實 adapter：tmux 指令、fetch、時鐘、contained / plain spawn。
 */
async function createPlainSession(sessionName: string, _skillCommand: string, token: string): Promise<boolean> {
  const claudePath = CLAUDE_BIN;
  const escapedToken = shSingleQuote(token);
  const tmuxDir = TMUX_BIN.includes('/') ? TMUX_BIN.slice(0, TMUX_BIN.lastIndexOf('/')) : '';
  const augmentedPath = [process.env.PATH || '', '/Users/ray/.local/bin', tmuxDir]
    .filter(Boolean)
    .join(':');
  const create = spawnSync(TMUX_BIN, [
    'new-session', '-d', '-s', sessionName, '-c', PROJECT_DIR,
    `TRIPLINE_API_TOKEN='${escapedToken}' TRIPLINE_TMUX_SESSION='${sessionName}' TMUX_BIN='${TMUX_BIN}' PATH='${augmentedPath}' ${claudePath} --dangerously-skip-permissions --name '${sessionName}'`
  ], { encoding: 'utf-8' });
  if (create.status !== 0) {
    logError(`tmux new-session failed (status=${create.status}): ${create.stderr || ''}`);
    return false;
  }

  return true;
}

const worker = createRequestWorker({
  fetch,
  apiBase: API_BASE,
  apiSecret: API_SECRET,
  getServiceToken: () => tokenHelper.getToken(),
  userTokenEnabled: (skillCommand) => {
    const flag = process.env.TP_REQUEST_USER_TOKEN;
    return (flag === '1' || flag === 'true') && skillCommand.trim() === '/tp-request';
  },
  tmux: {
    list: (format) => {
      const r = spawnSync(TMUX_BIN, ['ls', '-F', format], { encoding: 'utf-8' });
      return r.status === 0 ? (r.stdout || '') : null;
    },
    kill: (name) => { spawnSync(TMUX_BIN, ['kill-session', '-t', name]); },
    has: (name) => spawnSync(TMUX_BIN, ['has-session', '-t', name], { encoding: 'utf-8' }).status === 0,
  },
  clock: { now: () => Date.now() },
  sleep,
  pid: process.pid,
  log,
  logError,
  alert: (key, state, message) => { void throttledAlert(key, state, message); },
  containmentReady,
  createPlainSession,
  runContainedPrint,
  pane: tmuxDeps,
  attachLog: attachSessionLog,
});

/**
 * 啟動清掃：上一代 api-server 留下的 contained run（process + token 檔目錄）。
 * 新實例沒有任何自己的 run 在跑，所以 CONTAINED_BASE_DIR 底下符合 run 目錄格式的都是殘留。
 */
function sweepOnStartup(): void {
  try {
    // 清掃只需要 sudo 能力，不需要 OAuth token：OAuth 壞掉（containmentReady=false）正是最可能留下殘留的時候。
    if (runAsAgent(['true']).status !== 0) return;
    sweepStalePrintRuns({
      listEntries: () => {
        const r = runAsAgent(['ls', '-1', CONTAINED_BASE_DIR]);
        return r.status === 0 ? String(r.stdout).split('\n').filter(Boolean) : [];
      },
      killRun: (name) => killRunProcesses(`${CONTAINED_BASE_DIR}/${name}`),
      removeDir: (name) => runAsAgent(['rm', '-rf', `${CONTAINED_BASE_DIR}/${name}`]).status === 0,
      log,
      logError,
    });
  } catch (err) {
    logError(`啟動清掃失敗（不影響服務）：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 舊名保留給 HTTP / cron 接線：true = 本輪有 spawn。 */
async function processLoop(source: 'api' | 'job', skillCommand: string = '/tp-request'): Promise<boolean> {
  return (await worker.tick(source, skillCommand)) === 'spawned';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!;
  }
  return diff === 0;
}

function verifyAuth(req: Request): boolean {
  if (!API_SECRET) {
    logError('WARNING: TRIPLINE_API_SECRET not set — rejecting all requests');
    return false;
  }
  const authHeader = req.headers.get('Authorization') || '';
  return constantTimeEqual(authHeader, `Bearer ${API_SECRET}`);
}

// --- Mailer (lazy SMTP transporter + handler) ---
let mailTransporter: Transporter | null = null;
function getMailTransporter(): Transporter {
  if (!mailTransporter) {
    if (!GMAIL_USER || !GMAIL_PASS) {
      throw new Error('GMAIL_USERNAME or GMAIL_APP_PASSWORD not set');
    }
    mailTransporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
  }
  return mailTransporter;
}

const mailHandler = makeMailHandler({
  verifyAuth,
  transporter: getMailTransporter,
  emailFrom: EMAIL_FROM_DEFAULT,
  log,
  logError,
  // v2.33.128 G2：mail send observability — 失敗 throttledAlert + 成功 healthy
  // recovery（key per template，避免 password-reset 失敗 alert 跟 invitation 混在一起）
  onSendResult: (result) => {
    const key = `mail-${result.template ?? 'unknown'}`;
    if (result.ok) {
      void throttledAlert(
        key,
        'healthy',
        `🛡️ Tripline mail (${result.template ?? '-'}) 恢復寄送`,
      );
    } else {
      void throttledAlert(
        key,
        'failed',
        `🚨 Tripline /internal/mail/send 失敗\n` +
          `template=${result.template ?? '-'} to=${result.to}\n` +
          `subject=${result.subject.slice(0, 80)}\n` +
          `error=${(result.error ?? 'unknown').slice(0, 200)}\n` +
          `→ user 可重新 trigger 該流程（如 /api/oauth/send-verification）重發`,
      );
    }
  },
});

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS for health check
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        // v2.33.27: running 改報 array — backward-compat boolean 也保留
        ...worker.status(),
        uptime: process.uptime(),
      });
    }

    if (url.pathname === '/trigger' && req.method === 'POST') {
      if (!verifyAuth(req)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const source = (url.searchParams.get('source') === 'job' ? 'job' : 'api') as 'api' | 'job';

      // /trigger 預設跑 /tp-request；per-skill lock 只擋同 skill
      if (worker.isRunning('/tp-request')) {
        return Response.json({ already_running: true });
      }

      // 非同步啟動，立即回傳
      processLoop(source).catch((err) => {
        logError(`processLoop unhandled: ${err}`);
      });

      return Response.json({ triggered: true, source });
    }

    if (url.pathname === '/internal/mail/send' && req.method === 'POST') {
      return await mailHandler(req);
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  },
});

// listen 成功之後才清掃：port 被別的實例佔著時（EADDRINUSE）自己會先失敗，不會去殺對方進行中的 run。
// 這是同步呼叫，會在處理任何請求前跑完，所以不可能殺到這個實例剛起的 run。
sweepOnStartup();

log(`Tripline API Server listening on port ${PORT}`);

// ── v2.31.3: 內建多 schedule cron（取代 Cowork） ─────────────────────────
//
// 歷史 context：v2.30.5 把 launchd schedulers 改進 Claude Desktop Cowork，
// 但 Cowork 後端 API 化 + scheduled-tasks.json 不能直接寫，且重啟會清空 →
// 觀察到 2026-05-07 起 cron 完全停跑，user-submitted chat 卡 open 至 11 天
// （v2.30.18 加 15-min 內部 cron band-aid）。
//
// v2.31.3 廢棄 Cowork、擴成 3 schedule 主路徑：
// - /tp-request   每 30 分鐘（兜底；CF Pages POST 是第一線即時 trigger）
// - /tp-daily-check 每天 09:00（每日健康報告 + 自動 fix）
// - /tp-poi-enrich-monthly 每天 08:00（skill 內 day-1 guard，不是 1 號 noop exit）
//
// 用 setInterval + setTimeout-to-next-occurrence chain，不引 cron parser dep。
// v2.33.27: 鎖改 per-skill — 不同 skill 不互擋。
function fireSchedule(skillCommand: string, label: string): void {
  if (worker.isRunning(skillCommand)) {
    log(`Skip ${label} schedule (already running, skill=${skillCommand})`);
    return;
  }
  processLoop('job', skillCommand).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`internal cron ${label} processLoop unhandled: ${errMsg}`);
    // v2.33.127 G8：對齊 /tp-request alertAdminTelegram pattern — 之前 /tp-daily-check
    // 跟其他 cron processLoop 失敗只 logError 不告警，silently 死掉
    void throttledAlert(
      `cron-${label}`,
      'failed',
      `🚨 Tripline api-server cron ${label} processLoop unhandled error\nskill=${skillCommand}\nerror: ${errMsg.slice(0, 200)}`,
    );
  });
}

// 排程到下一次每日固定時段（hour:minute），之後改 24h interval
function scheduleDaily(hour: number, minute: number, skillCommand: string, label: string): void {
  const { next, delayMs } = computeNextDailyFire(new Date(), hour, minute);
  log(`Scheduled ${label} (${skillCommand}) first fire at ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);
  setTimeout(() => {
    fireSchedule(skillCommand, label);
    setInterval(() => fireSchedule(skillCommand, label), 24 * 60 * 60 * 1000);
  }, delayMs);
}

// v2.31.96: 對外部 bash/bun script 的 fire-and-forget helper（不走 claude/tmux）
// 接 v2.31.3 launchd 廢棄後 orphan 的 daily scripts（refresh:google / auth-cleanup）。
// 不共用 isRunning 鎖 — 跑 script 不爭 tmux session，獨立走自己日誌。
async function fireScheduleScript(cmd: string, args: string[], label: string): Promise<void> {
  log(`Firing script: ${label} (${cmd} ${args.join(' ')})`);
  try {
    const { spawn } = await import('node:child_process');
    const { openSync } = await import('node:fs');
    const outFd = openSync(join(LOG_DIR, `script-${label}-${todayStr()}.log`), 'a');
    const errFd = openSync(join(LOG_DIR, `script-${label}-${todayStr()}.err`), 'a');
    const child = spawn(cmd, args, {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.on('error', (err) => {
      logError(`Script ${label} spawn error: ${err.message}`);
      void throttledAlert(
        `script-spawn-${label}`,
        'failed',
        `🚨 Tripline cron script ${label} spawn error\ncmd=${cmd} args=${args.join(' ')}\nerror: ${err.message.slice(0, 200)}`,
      );
    });
    // v2.33.127 G3：之前 detached spawn 完全不檢查 exit code → node ENOENT /
    // npm script crash 全 silent skip。listen exit + 非 0 alert（unref 後仍 fire，
    // bun 不 detach event loop）。
    child.on('exit', (code, signal) => {
      if (code === 0) {
        log(`Script ${label} exited cleanly (code=0)`);
        // 成功：throttledAlert 用 'healthy' state（若先前 failed 會發 recovery alert）
        void throttledAlert(
          `script-exit-${label}`,
          'healthy',
          `🛡️ Tripline cron script ${label} 恢復正常`,
        );
      } else {
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        logError(`Script ${label} exited non-zero (${reason})`);
        void throttledAlert(
          `script-exit-${label}`,
          'failed',
          `🚨 Tripline cron script ${label} exit ${reason}\ncmd=${cmd} args=${args.join(' ')}\n` +
            `查 log：scripts/logs/script-${label}-${todayStr()}.{log,err}`,
        );
      }
    });
    child.unref();
  } catch (err) {
    logError(`fireScheduleScript ${label} setup failed: ${(err as Error).message}`);
    void throttledAlert(
      `script-setup-${label}`,
      'failed',
      `🚨 Tripline cron script ${label} setup failed\nerror: ${(err as Error).message}`,
    );
  }
}

function scheduleDailyScript(hour: number, minute: number, cmd: string, args: string[], label: string): void {
  const { next, delayMs } = computeNextDailyFire(new Date(), hour, minute);
  log(`Scheduled ${label} first fire at ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);
  setTimeout(() => {
    void fireScheduleScript(cmd, args, label);
    setInterval(() => void fireScheduleScript(cmd, args, label), 24 * 60 * 60 * 1000);
  }, delayMs);
}

// 5 分鐘 /tp-request 兜底（v2.31.5：30 → 10 min；現改 5 min，CF Pages POST /trigger 失敗（如 530）時使用者最多等 5 分鐘）
const REQUEST_CRON_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => fireSchedule('/tp-request', 'request-handler'), REQUEST_CRON_INTERVAL_MS);
log(`Scheduled request-handler (/tp-request) every ${REQUEST_CRON_INTERVAL_MS / 60000} min`);

// v2.31.97: 改 06:10（早於 4:00 auth-cleanup / 4:30 refresh:google 是不行的，
// daily-check 必須在它要稽核的 schedule 之後 — Ray 想早一點看每日報告但不能撞 cron）。
// 06:10 給 04:30 refresh 留 ~100 min 完成 50 POI × 1.5s sleep + Place Details
// API + 緩衝（實測 ~3-5 min，但保險）。
scheduleDaily(6, 10, '/tp-daily-check', 'daily-check');

// v2.31.96: 接 v2.31.3 launchd 廢棄後 orphan 的 3 個 daily script。
// 故事：v2.31.3 把 launchd com.tripline.daily-check 整批廢棄、改 api-server
// 內部 cron，但只搬 /tp-daily-check，其他 daily 任務沒人接 → 13 天沒跑。
//
// google-poi-refresh-30d 04:30 — 30 天滾動 refresh POI lifecycle (50 POI/day cap)。
//   沒跑：pois.status_checked_at 不更新、TripHealthBanner 看不到「永久結業」。
// auth-cleanup 04:00 — V2-P6 retention sweep（auth_audit_log + session_devices
//   + oauth_models 30 天）。沒跑：表會無限增長。
//
// /tp-poi-enrich-monthly 仍維持 v2.31.4 移除狀態（batch enrich 已被 即時
// POST /api/pois/:id/enrich + 30d refresh 取代）。
scheduleDailyScript(4, 0, NODE_BIN, ['scripts/auth-cleanup.js'], 'auth-cleanup');
scheduleDailyScript(4, 30, BUN_BIN, ['run', 'refresh:google'], 'google-poi-refresh');
// v2.33.131 G13: log retention sweep — scripts/logs/ 下 per-date files > 30d
// 刪除 + 超大單檔 truncate 保留 tail 50%。PR4 exit code wrapper 自動接 alert。
scheduleDailyScript(3, 30, 'zsh', ['scripts/log-rotate.sh'], 'log-rotate');
