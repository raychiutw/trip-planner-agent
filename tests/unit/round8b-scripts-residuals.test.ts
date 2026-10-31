/**
 * round8b-scripts-residuals.test.ts — v2.33.50 round 8b scripts hardening
 *
 * Source-grep guard for HIGH/MED fixes:
 *  1. provision-admin-cli --rotate-secret cascade revoke oauth_access_tokens + oauth_refresh_tokens
 *  2. daily-report.js /api/trips 加 auth via getTriplineToken
 *  3. _lib/cron-shared.ts alertTelegram warn-on-missing + token format validate
 *  4. lib/d1-client.js 5xx retry + only-errors stringify (拔 request body leak)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PROVISION_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/provision-admin-cli-client.js'),
  'utf-8',
);
const DAILY_REPORT_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/daily-report.js'),
  'utf-8',
);
const CRON_SHARED_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/_lib/cron-shared.ts'),
  'utf-8',
);
const D1_CLIENT_SRC = readFileSync(
  path.resolve(__dirname, '../../scripts/lib/d1-client.js'),
  'utf-8',
);

describe('v2.33.50 round 8b — provision-admin-cli cascade revoke', () => {
  it('--rotate-secret cascade revoke 打 oauth_models (F2: 對表 + client_id snake)', () => {
    // F2（Phase 2）：token 存 oauth_models（name='AccessToken'/'RefreshToken'、payload.client_id），
    // 非 oauth_access_tokens/oauth_refresh_tokens（兩表不存在 → 舊版 DELETE silent no-op）。
    expect(PROVISION_SRC).toContain("DELETE FROM oauth_models WHERE name IN ('AccessToken','RefreshToken')");
    expect(PROVISION_SRC).toContain("json_extract(payload, '$.client_id')");
    expect(PROVISION_SRC).not.toContain('DELETE FROM oauth_access_tokens');
    expect(PROVISION_SRC).not.toContain('DELETE FROM oauth_refresh_tokens');
  });

  it('--keep-tokens opt-out flag 存在 (rare graceful rollover)', () => {
    expect(PROVISION_SRC).toContain("'--keep-tokens'");
    expect(PROVISION_SRC).toContain('keepTokens');
  });

  it('F2: cascade-revoke 在 client_apps DELETE 前 + hard-fail (無 silent warning)', () => {
    // F2（Phase 2）：撤銷失敗直接往上拋（main().catch exit 1），不再 try/catch 吞成 warning
    // 後繼續發 secret；revoke 移到 client_apps DELETE 前，hard-fail 時舊狀態完整保留。
    expect(PROVISION_SRC).not.toMatch(/failed to cascade-revoke tokens/);
    const revokeIdx = PROVISION_SRC.indexOf('DELETE FROM oauth_models');
    const clientDelIdx = PROVISION_SRC.indexOf('DELETE FROM client_apps WHERE client_id = ?');
    expect(revokeIdx).toBeGreaterThan(0);
    expect(clientDelIdx).toBeGreaterThan(revokeIdx);
  });
});

describe('v2.33.50 round 8b — daily-report.js auth on /api/trips', () => {
  it('import getTriplineToken from lib/get-tripline-token', () => {
    expect(DAILY_REPORT_SRC).toMatch(/getToken: getTriplineToken/);
    expect(DAILY_REPORT_SRC).toContain("require('./lib/get-tripline-token')");
  });

  it('/api/trips + /days fetch 都帶 authHeaders', () => {
    expect(DAILY_REPORT_SRC).toContain("/api/trips', { headers: authHeaders }");
    expect(DAILY_REPORT_SRC).toMatch(/\/days', \{ headers: authHeaders \}/);
  });

  it('daily-report.yml 要把 mint token 需要的 credential 傳進去', () => {
    // 上面那條「不准吞錯」只保證失敗會被看見，不保證檢查跑得起來。CI 的 env 少了
    // 這兩個 → get-tripline-token.js:87 直接拋 → 連結區塊天天紅。兩條要一起在，
    // 否則就只是把「每天假綠」換成「每天真紅」，一樣沒人知道連結到底好不好。
    const yml = readFileSync(path.resolve(__dirname, '../../.github/workflows/daily-report.yml'), 'utf-8');
    expect(yml).toContain('TRIPLINE_API_CLIENT_ID: ${{ secrets.TRIPLINE_API_CLIENT_ID }}');
    expect(yml).toContain('TRIPLINE_API_CLIENT_SECRET: ${{ secrets.TRIPLINE_API_CLIENT_SECRET }}');
  });
});

// cron-shared.alertTelegram 的防禦（缺設定警告一次、token 格式驗證、env 優先序）改以行為測試：tests/unit/cron-alert-telegram.test.ts

describe('v2.33.50 round 8b — d1-client.js 5xx retry + safer error', () => {
  it('1 retry on 5xx with 500ms backoff', () => {
    expect(D1_CLIENT_SRC).toContain('for (let attempt = 0; attempt < 2; attempt++)');
    expect(D1_CLIENT_SRC).toContain("res.status < 500 || attempt > 0");
    expect(D1_CLIENT_SRC).toContain('setTimeout(r, 500)');
  });

  it('error stringify 只用 errors 不 fallback json (拔 SQL params leak)', () => {
    expect(D1_CLIENT_SRC).toContain("json.errors || 'unknown'");
    expect(D1_CLIENT_SRC).not.toContain('json.errors || json');
  });
});
