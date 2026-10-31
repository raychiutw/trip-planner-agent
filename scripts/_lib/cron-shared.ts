/**
 * cron-shared.ts — common helpers for mac mini cron scripts that hit Tripline API
 * + emit Telegram alerts.
 *
 * Auth model: V2 OAuth client_credentials flow (mirrors scripts/lib/get-tripline-token.js).
 *   Required env: TRIPLINE_API_CLIENT_ID + TRIPLINE_API_CLIENT_SECRET (provisioned via
 *   scripts/provision-admin-cli-client.js).
 *   Token is minted lazily on first API call + cached at /tmp/tripline-cli-token-${uid}.json
 *   (file shared with get-tripline-token.js so we hit the same cache).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import envLoader from '../lib/load-env.js';
import telegram from '../lib/telegram.js';

export interface CronEnv {
  apiUrl: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_API = 'https://trip-planner-dby.pages.dev';
const REFRESH_LEADTIME_SEC = 60;

/** Load TRIPLINE_API_URL + TRIPLINE_API_CLIENT_ID/SECRET from env then .env.local fallback.
 * 解析交給 `lib/load-env.js` 的 parseEnv（去引號、驗 key、支援多行值）。
 */
export function loadCronEnv(): CronEnv {
  const envPath = join(envLoader.REPO_ROOT, '.env.local');
  const raw = (() => {
    try { return readFileSync(envPath, 'utf-8'); } catch { return ''; }
  })();
  // 全 repo 唯一的 .env.local parser（scripts/lib/load-env.js）：支援跨多行值、去引號、驗 key。
  const map = new Map<string, string>(Object.entries(envLoader.parseEnv(raw)));
  // TRIPLINE_API_BASE = CF Pages deployment (admin endpoints + new v2.23 endpoints).
  // TRIPLINE_API_URL = mac mini Tailscale funnel (legacy /api routes only) — DO NOT USE.
  const apiUrl = (
    process.env.TRIPLINE_API_BASE ||
    map.get('TRIPLINE_API_BASE') ||
    DEFAULT_API
  ).trim();
  const clientId = (process.env.TRIPLINE_API_CLIENT_ID || map.get('TRIPLINE_API_CLIENT_ID') || '').trim();
  const clientSecret = (process.env.TRIPLINE_API_CLIENT_SECRET || map.get('TRIPLINE_API_CLIENT_SECRET') || '').trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Required env: TRIPLINE_API_CLIENT_ID + TRIPLINE_API_CLIENT_SECRET (provision via scripts/provision-admin-cli-client.js)',
    );
  }
  return { apiUrl, clientId, clientSecret };
}

function cachePath(): string {
  const uid = (process.getuid && process.getuid()) || 0;
  return join(tmpdir(), `tripline-cli-token-${uid}.json`);
}

function readTokenCache(): string | null {
  try {
    const p = cachePath();
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as {
      access_token?: string; expires_at?: number;
    };
    if (
      typeof parsed.access_token === 'string' &&
      typeof parsed.expires_at === 'number' &&
      parsed.expires_at - REFRESH_LEADTIME_SEC > Math.floor(Date.now() / 1000)
    ) {
      return parsed.access_token;
    }
  } catch { /* corrupt cache — fall through */ }
  return null;
}

function writeTokenCache(token: string, expiresInSec: number): void {
  const payload = {
    access_token: token,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
  };
  try {
    writeFileSync(cachePath(), JSON.stringify(payload), { mode: 0o600 });
  } catch { /* cache failure non-fatal */ }
}

async function mintToken(env: CronEnv, scopes?: string): Promise<string> {
  // Phase 2（移除全域 admin）：不再硬寫 'admin' default。無 scope → token endpoint 回
  // client allowed_scopes（rotate 後 = ops scope，自動適配，見 oauth/token.ts:239）。
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.clientId,
    client_secret: env.clientSecret,
  });
  if (scopes) body.set('scope', scopes);
  const res = await fetch(`${env.apiUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // 字面 null body：catch(()=>({})) 擋不到（res.json() 回 null 不 throw）→ 用 ?? {}。
  const json = ((await res.json().catch(() => null)) ?? {}) as {
    access_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  // access_token 必須是非空字串 — 否則 `Bearer ${token}` 會送 "[object Object]"。
  if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
    throw new Error(`Token mint failed (${res.status}): ${json.error || ''} ${json.error_description || ''}`.trim());
  }
  writeTokenCache(json.access_token, json.expires_in || 3600);
  return json.access_token;
}

/** Bound API client — auto-mints OAuth Bearer token + retries once on 401. */
export function makeApiClient(env: CronEnv) {
  let token: string | null = readTokenCache();
  return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!token) token = await mintToken(env);
    let res = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      token = await mintToken(env);
      res = await fetch(`${env.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    // 200 但 body 空 / 非-JSON（例：CF 200-HTML edge block）→ fail loud。舊
    // `return (await res.json())` 對空 body 一樣 throw（SyntaxError），這裡只是收斂成
    // 講清楚 body 問題的訊息 — 對讀屬性的 caller（const status = await api<...>）與
    // fire-and-forget PATCH（google-poi-initial-backfill.ts:107/118 丟棄回傳值）行為都不變。
    const json = (await res.json().catch(() => undefined)) as T | undefined;
    if (json == null) {
      throw new Error(`${method} ${path} → ${res.status} 但 body 空/非-JSON`);
    }
    return json;
  };
}

// 送出規則（token／chat id 驗證、env 優先序、不丟例外）全在 scripts/lib/telegram.js。
// 這裡只保留「設定缺失／格式錯誤各只警告一次」——靜默 no-op 正是 daily-check 要 surface 的故障模式，
// 但每次 alert 都 spam stderr 沒有意義（模組級 flag）。
const _telegramWarned = new Set<string>();
/** Telegram alert (best-effort). */
export async function alertTelegram(msg: string): Promise<void> {
  const r = await telegram.sendTelegram(msg);
  if (!r.ok && (r.reason === 'not-configured' || r.reason === 'bad-token' || r.reason === 'bad-chat') && !_telegramWarned.has(r.reason)) {
    _telegramWarned.add(r.reason);
    console.warn(`[alertTelegram] Telegram 設定不可用（${r.reason}）— alerts disabled`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── throttled-alert (TS variant) ──────────────────────────────────────────
//
// 配對 scripts/lib/throttled-alert.sh — 給 cron scripts / api-server 用同一
// state-transition + 1hr throttle 規則，避免 sustained failure 把 Telegram flood。
//
// State cache：~/.gstack/throttled-alert-<key>.state（若 ~/.gstack 不存在則 fallback /tmp）
// 格式 "state|epoch_seconds"。
//
// Rules（與 .sh 版完全對齊）：
//   - new="healthy" + prev != healthy/unknown → recovery alert always
//   - new="healthy" + prev=healthy/unknown → silent
//   - state change → alert
//   - same state → 每 ttlSec 一次（default 3600）

// (mkdirSync 取 node:fs；existsSync/readFileSync/writeFileSync + join 同 top imports)
import { mkdirSync } from 'fs';
import { homedir } from 'os';

const THROTTLE_DEFAULT_DIR = (() => {
  const gstack = join(homedir(), '.gstack');
  return existsSync(gstack) ? gstack : '/tmp';
})();

function stateFilePath(key: string, dir = THROTTLE_DEFAULT_DIR): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `throttled-alert-${safe}.state`);
}

function readState(file: string): { state: string; ts: number } {
  if (!existsSync(file)) return { state: 'unknown', ts: 0 };
  const raw = readFileSync(file, 'utf8').trim();
  const [state, tsStr] = raw.split('|');
  const ts = /^\d+$/.test(tsStr ?? '') ? Number(tsStr) : 0;
  return { state: state || 'unknown', ts };
}

function writeState(file: string, state: string, ts: number): void {
  writeFileSync(file, `${state}|${ts}\n`);
}

export function shouldSendAlert(
  prevState: string,
  newState: string,
  prevTs: number,
  now: number,
  ttlSec: number,
): boolean {
  if (newState === 'healthy' && prevState !== 'healthy' && prevState !== 'unknown') {
    return true; // recovery
  }
  if (newState === 'healthy') return false;
  if (prevState !== newState) return true;
  return now - prevTs >= ttlSec;
}

/**
 * Send Telegram alert respecting state-transition + throttle rules.
 *
 * @returns true if alert was sent, false if suppressed by throttle/steady-state
 */
export async function throttledAlert(
  key: string,
  newState: string,
  message: string,
  options?: { ttlSec?: number; stateDir?: string },
): Promise<boolean> {
  const ttlSec = options?.ttlSec ?? 3600;
  const file = stateFilePath(key, options?.stateDir);
  const { state: prevState, ts: prevTs } = readState(file);
  const now = Math.floor(Date.now() / 1000);

  if (shouldSendAlert(prevState, newState, prevTs, now, ttlSec)) {
    await alertTelegram(message);
    writeState(file, newState, now);
    return true;
  }
  // 保留舊 ts 維持 throttle window
  writeState(file, newState, prevTs);
  return false;
}
