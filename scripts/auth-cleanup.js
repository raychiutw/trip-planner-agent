#!/usr/bin/env node
/**
 * auth-cleanup.js — V2-P6 retention sweep
 *
 * 每日清掉過期 auth_audit_log + session_devices row。Cloudflare Pages 沒原生
 * cron triggers，所以這支 script 由 launchd / cron 每日呼叫（同 daily-check.js
 * 的執行方式）。
 *
 * Retention 策略（per autoplan）：
 *   - auth_audit_log: 30 天 → DELETE WHERE created_at < datetime('now', '-30 days')
 *   - session_devices: revoked 後 30 天 OR last_seen 超過 30 天 → DELETE
 *
 * 註冊方式（launchd）：複製 com.tripline.auth-cleanup.plist 範本（見下方註解）
 *   到 ~/Library/LaunchAgents 並 launchctl load。
 *
 * 環境變數同 daily-check.js（CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID）。
 */
'use strict';

// v2.33.29: 用 shared scripts/lib/load-env + d1-client，原本 inline 的
// loadEnvLocal + execD1 已移除。
require('./lib/load-env').loadEnvLocal();
const { execD1 } = require('./lib/d1-client');

if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CF_ACCOUNT_ID || !process.env.D1_DATABASE_ID) {
  console.error('[auth-cleanup] missing CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DATABASE_ID');
  process.exit(2);
}

(async function main() {
  var report = {
    auth_audit_log: 0,
    session_devices: 0,
    oauth_models: 0,
    // v2.33.60 round 14: retention sweep 新增 4 個表
    trip_invitations: 0,
    pois_search_cache: 0,
    companion_request_actions: 0,
    error_reports: 0,
    // v2.33.61 round 14b
    trip_health_reports: 0,
    api_logs: 0,
    // item-4 (owner 2026-07-22)
    audit_log: 0,
  };

  // 1. auth_audit_log — 60 天保留（owner 2026-07-22：由 30 放寬到 60，與 api_logs /
  //    audit_log 對齊）
  report.auth_audit_log = await execD1(
    "DELETE FROM auth_audit_log WHERE created_at < datetime('now', '-60 days')"
  );

  // 2. session_devices — revoked 後 30 天或 30 天無活動
  report.session_devices = await execD1(
    "DELETE FROM session_devices " +
    "WHERE (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-30 days')) " +
    "   OR (revoked_at IS NULL AND last_seen_at < datetime('now', '-30 days'))"
  );

  // 3. oauth_models — 過期 row 也順便清（D1Adapter.sweepExpired 邏輯，cron 統一在這跑）
  report.oauth_models = await execD1(
    "DELETE FROM oauth_models WHERE expires_at < strftime('%s', 'now') * 1000"
  );

  // 4. trip_invitations — v2.33.60: PII (invited_email + trip_id 對應) 與
  //    token_hash (HMAC of raw token) 不該無限保留。Accepted 90 天 / Expired 30 天後刪。
  report.trip_invitations = await execD1(
    "DELETE FROM trip_invitations " +
    "WHERE (accepted_at IS NOT NULL AND accepted_at < datetime('now', '-90 days')) " +
    "   OR (accepted_at IS NULL AND expires_at < datetime('now', '-30 days'))"
  );

  // 5. pois_search_cache — v2.33.60: expires_at 是 TTL signal 但無人 sweep。
  //    Stale row 仍占 index + 增 DB scan cost。
  report.pois_search_cache = await execD1(
    "DELETE FROM pois_search_cache WHERE expires_at < datetime('now')"
  );

  // 6. companion_request_actions — v2.33.60: append-only audit row，90 天足夠 forensics。
  report.companion_request_actions = await execD1(
    "DELETE FROM companion_request_actions WHERE created_at < datetime('now', '-90 days')"
  );

  // 7. error_reports — v2.33.60: 含 user_agent fingerprint + 攻擊者控的 context 字串，
  //    無限保留 = PII bloat + 攻擊面增加。90 天 forensics 已夠。
  report.error_reports = await execD1(
    "DELETE FROM error_reports WHERE created_at < datetime('now', '-90 days')"
  );

  // 8. trip_health_reports — v2.33.61: findings_json 含 trip 自由文 (emergency
  //    contact / address / 醫療資訊等 PII)。30 天 stale = user 沒 re-trigger 健檢，
  //    舊 finding 無人讀，刪掉。trip_id PK upsert 模式 — 沒 cron 跑就無限保留。
  report.trip_health_reports = await execD1(
    "DELETE FROM trip_health_reports WHERE completed_at IS NOT NULL AND completed_at < datetime('now', '-30 days')"
  );

  // 9. api_logs — v2.33.61: 之前在 daily-report.js 跑 (mac mini 單點故障，
  //    機器 offline > 30d 表會無限長)。挪到本 cron (CF Pages 30 min 觸發更可靠)。
  //    60 天保留與 daily-report 原 policy 一致。
  report.api_logs = await execD1(
    "DELETE FROM api_logs WHERE created_at < datetime('now', '-60 days')"
  );

  // 10. audit_log — item-4 (owner 2026-07-22)：行程變更稽核（trip_id / action /
  //     diff_json / snapshot）。rollback 功能（functions/api/trips/[id]/audit/[aid]/rollback.ts）
  //     在讀，但無限保留 = 無界成長 + 舊 diff/snapshot 含行程自由文 PII。owner 決策
  //     60 天保留（與 api_logs / auth_audit_log 對齊；明確接受 rollback 只回溯 60 天，
  //     超過的還原點會被清）。created_at 有 idx_audit_time 索引（0071），走索引不全表掃。
  report.audit_log = await execD1(
    "DELETE FROM audit_log WHERE created_at < datetime('now', '-60 days')"
  );

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    skill: 'auth-cleanup',
    deleted: report,
  }));
})().catch(function (err) {
  console.error('[auth-cleanup] FAILED:', err.message);
  process.exit(1);
});
