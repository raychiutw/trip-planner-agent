/**
 * round8a-scripts-security.test.ts — v2.33.49 round 8a scripts hardening
 *
 * Source-grep guard for 6 個 fix:
 *  1. api-server skillCommand allowlist
 *  2. tripline-job.sh .env strip quotes + exit 1 on unreachable
 *  3. get-tripline-token.js 用 shared loadEnvLocal
 *  4. _lib/cron-shared.ts quote-strip 對齊 lib/load-env.js
 *  5. smoke poi-favorites-rename `set -euo pipefail`
 *  6. send-telegram.sh TOKEN format validation
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const API_SERVER_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/tripline-api-server.ts'),
  'utf-8',
);
// #1264：allowlist / peek / mint 決策搬進 request worker module，這幾條 lock 跟著搬。
const WORKER_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/lib/request-worker.ts'),
  'utf8',
);
const JOB_SH_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/tripline-job.sh'),
  'utf-8',
);
const TOKEN_HELPER_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/lib/get-tripline-token.js'),
  'utf-8',
);
const CRON_SHARED_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/_lib/cron-shared.ts'),
  'utf-8',
);
const TELEGRAM_SH_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/lib/send-telegram.sh'),
  'utf-8',
);

describe('v2.33.49 round 8a — api-server skillCommand allowlist', () => {
  it('ALLOWED_SKILLS Set 含 /tp-request + /tp-daily-check', () => {
    expect(WORKER_SRC).toMatch(/ALLOWED_SKILLS\s*=\s*new Set\(\[['"]\/tp-request['"],\s*['"]\/tp-daily-check['"]/);
  });

  it('assertAllowedSkill 在 sessionPrefixForSkill / tick 都 gate（module）', () => {
    expect(WORKER_SRC).toMatch(/export function assertAllowedSkill/);
    expect(WORKER_SRC).toMatch(/function sessionPrefixForSkill[\s\S]{0,120}assertAllowedSkill\(skillCommand\)/);
    expect(WORKER_SRC).toMatch(/async function tick\([\s\S]{0,160}assertAllowedSkill\(skillCommand\)/);
  });
});

describe('v2.33.49 round 8a — tripline-job.sh env hardening', () => {
  it('.env.local 走共用 parser（去引號與 key 驗證由 load-env.js 的 parseEnv 負責，見 env-local-parse.test.ts）', () => {
    expect(JOB_SH_SRC).toContain('scripts/lib/load-env.mjs');
    expect(JOB_SH_SRC).not.toMatch(/while IFS= read -r line/);
  });

  it('API server unreachable → exit 1 (不 mask outage)', () => {
    const idx = JOB_SH_SRC.indexOf('API server 不可用');
    expect(idx).toBeGreaterThan(-1);
    const after = JOB_SH_SRC.slice(idx, idx + 300);
    expect(after).toContain('exit 1');
    // 注意 comment 內 'exit 0' 是說明 — 行動 statement 要 exit 1
    // 後面 200 chars 內不能有未 prefix '#' 的 'exit 0'
    expect(after.split('\n').filter((l) => l.trim() === 'exit 0')).toHaveLength(0);
  });
});

describe('v2.33.49 round 8a — get-tripline-token.js shared parser', () => {
  it('使用 shared loadEnvLocal (拔 legacy inline regex)', () => {
    expect(TOKEN_HELPER_SRC).toMatch(/require\(['"]\.\/load-env['"]\)/);
    expect(TOKEN_HELPER_SRC).toMatch(/loadEnvLocal\(\)/);
    // 確認舊 regex pattern 不在
    expect(TOKEN_HELPER_SRC).not.toMatch(/line\.match\(\/\^\\\(w\+\)=/);
  });
});

// cron-shared 的 .env 解析已改走 lib/load-env.js 的 parseEnv；去引號／驗 key 的行為見 env-local-parse.test.ts。

describe('token 端點 null-safe parse（2026-07-13 prod null-body 事故）', () => {
  // 2026-07-12 prod /api/oauth/token 短暫回「非-2xx + 字面 `null` body」。舊
  // `const json = await res.json()` 讓 json=null，錯誤處理在 `json.error` 上爆
  // "null is not an object (evaluating 'json.error')"，蓋掉真正 HTTP 狀態碼 →
  // api-server tokenHelper.getToken() 失敗、daily-check + tp-request 一起停 spawn。
  // 修法 `(await res.json().catch(() => null)) ?? {}` 同時擋「非-JSON body」與
  // 「字面 null body」兩種，錯誤訊息保留 HTTP status 可診斷。
  // 鎖「完整 idiom」而非只鎖 `.catch(() => null)`：若有人拿掉 `?? {}` 只留 catch，
  // 字面 null body 的 null deref 就回來了，presence-only 斷言會誤放（adversarial review 抓到）。
  it('get-tripline-token.js: 完整 null-safe idiom (含 ?? {})，拔掉裸 await res.json()', () => {
    expect(TOKEN_HELPER_SRC).toContain('res.json().catch(() => null)) ?? {}');
    expect(TOKEN_HELPER_SRC).not.toContain('const json = await res.json();');
  });

  it('cron-shared.ts: mintToken 完整 idiom (取代 catch(()=>({})))', () => {
    expect(CRON_SHARED_SRC).toContain('res.json().catch(() => null)) ?? {}');
    expect(CRON_SHARED_SRC).not.toContain('res.json().catch(() => ({}))');
  });

  it('request-worker.ts mint-restricted: 完整 null-safe idiom (含 ?? {})', () => {
    expect(WORKER_SRC).toContain('res.json().catch(() => null)) ?? {}');
  });

  it('tripline-api-server.ts peekPendingRequest: null-safe json()（同事故類別，防 data.items 爆 null）', () => {
    // /api/requests 回 null/非-JSON body → data.items 爆 TypeError（fail-closed 但同 2026-07-12 事故類別）。
    expect(WORKER_SRC).not.toContain('const data = (await res.json()) as');
    expect(API_SERVER_SRC).not.toContain('const data = (await res.json()) as');
  });

  it('token mint 三處都用 typeof-string 驗證 access_token（防 Bearer [object Object]）', () => {
    expect(TOKEN_HELPER_SRC).toContain("typeof json.access_token !== 'string'");
    expect(CRON_SHARED_SRC).toContain("typeof json.access_token !== 'string'");
    expect(WORKER_SRC).toContain("typeof data.access_token !== 'string'");
  });

  it('cron-shared makeApiClient: 200 空/非-JSON body → fail loud（不回 null as T）', () => {
    expect(CRON_SHARED_SRC).not.toContain('return (await res.json()) as T;');
    expect(CRON_SHARED_SRC).toContain('res.json().catch(() => undefined)');
  });
});

describe('v2.33.49 round 8a — send-telegram TOKEN validation', () => {
  it('TOKEN format regex check', () => {
    expect(TELEGRAM_SH_SRC).toMatch(/\[0-9\]\+:\[A-Za-z0-9_-\]\+/);
    expect(TELEGRAM_SH_SRC).toMatch(/TELEGRAM_BOT_TOKEN 格式不合法/);
  });

  it('CHAT_ID 必須 numeric', () => {
    expect(TELEGRAM_SH_SRC).toMatch(/\^-\?\[0-9\]\+\$/);
  });
});
