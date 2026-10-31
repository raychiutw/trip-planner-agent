#!/usr/bin/env node
/**
 * provision-admin-cli-client.js — one-shot helper to register a confidential
 * client_app row for CLI scripts (tp-request-scheduler / tripline-job /
 * tripline-api-server) against the prod D1 database.
 *
 * Why this exists: `/api/dev/apps` requires a session, but the CLI scripts
 * need a client_app to FETCH a session (chicken-and-egg). This script writes
 * the row directly via the Cloudflare D1 REST API using `CLOUDFLARE_API_TOKEN`
 * — admin-only, run once at cutover.
 *
 * Usage:
 *
 *   node scripts/provision-admin-cli-client.js
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN  — token with D1:Read+Write on the prod database
 *   CF_ACCOUNT_ID         — Cloudflare account id
 *   D1_DATABASE_ID        — production D1 db id (see wrangler.toml)
 *
 * Optional env:
 *   ADMIN_EMAIL_OVERRIDE  — owner_user_id is set to the user with this email
 *                          （必填；擁有者 email 不內建在 repo）
 *   CLIENT_ID_OVERRIDE    — defaults to 'tripline-internal-cli'
 *
 * Output: prints the generated client_secret to stdout (one-time only — DB
 * stores the hash). Save it immediately to your launchd plist or .env.local
 * as `TRIPLINE_API_CLIENT_SECRET`.
 *
 * Safety:
 *   - Idempotent: if client already exists, prints existing row + offers to
 *     re-secret (DELETE + reinsert with new secret).
 *   - Refuses to run against the staging DB (matches production id).
 */
'use strict';

const { execSync } = require('child_process');

// Load .env.local if present（全 repo 唯一的 parser：scripts/lib/load-env.js）
require('./lib/load-env').loadEnvLocal();

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const D1_DB = process.env.D1_DATABASE_ID;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL_OVERRIDE;
if (!ADMIN_EMAIL) {
  console.error('Missing ADMIN_EMAIL_OVERRIDE env（擁有者 email，不內建在 repo）');
  process.exit(2);
}
const CLIENT_ID = process.env.CLIENT_ID_OVERRIDE || 'tripline-internal-cli';

if (!CF_TOKEN || !CF_ACCOUNT || !D1_DB) {
  console.error('Missing CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID / D1_DATABASE_ID env');
  process.exit(2);
}

// v2.33.29: 改用 shared scripts/lib/d1-client (returns rows for SELECT).
const { queryD1, execD1 } = require('./lib/d1-client');
// v2.55.54: secret gen + PBKDF2 hash 抽到 shared scripts/lib/oauth-provision（消除與
// provision-tp-request-client.js 的重複；PBKDF2 iter 對齊 src/server/password.ts）。
const { generateClientSecret, hashPassword } = require('./lib/oauth-provision');

(async function main() {
  // Look up admin user id
  const userRows = await queryD1('SELECT id FROM users WHERE email = ? LIMIT 1', [ADMIN_EMAIL]);
  if (userRows.length === 0) {
    console.error(
      `Admin user not found in users table for email "${ADMIN_EMAIL}". ` +
      'Sign up via /signup first, then re-run this script.',
    );
    process.exit(3);
  }
  const ownerUserId = userRows[0].id;

  // Check if client already exists
  const existing = await queryD1('SELECT client_id, status FROM client_apps WHERE client_id = ?', [
    CLIENT_ID,
  ]);
  if (existing.length > 0) {
    const proceed = process.argv.includes('--rotate-secret');
    if (!proceed) {
      console.error(
        `client_id "${CLIENT_ID}" already exists (status: ${existing[0].status}). ` +
          'Pass --rotate-secret to delete and reissue with a new secret.',
      );
      process.exit(4);
    }
    // F2（Phase 2 / security-auditor）：先 cascade-revoke live tokens，再刪 client_apps。
    // 舊版打 oauth_access_tokens / oauth_refresh_tokens — 兩表不存在，execD1 永遠 throw →
    // catch 吞成 warning → 撤銷 silent no-op，舊 token 活到 1h expiry（若 rotate 動機是
    // secret 外洩，這 1h 就是攻擊窗口）。token 實存 oauth_models（name='AccessToken'/
    // 'RefreshToken'、payload.client_id snake，見 oauth/token.ts:101 + _middleware.ts:18）。
    // 打對表 + hard-fail：execD1 失敗直接往上拋（main().catch exit 1），此時 client_apps
    // 還沒刪、新 secret 沒發，舊狀態完整保留（不留「client 沒了又沒新 secret」壞狀態）。
    const keepTokens = process.argv.includes('--keep-tokens');
    if (keepTokens) {
      console.error('[--keep-tokens] live access tokens 保留至自然 expiry。請手動 revoke 視需求。');
    } else {
      const revoked = await execD1(
        "DELETE FROM oauth_models WHERE name IN ('AccessToken','RefreshToken') AND json_extract(payload, '$.client_id') = ?",
        [CLIENT_ID],
      );
      console.error(`Cascade revoked ${revoked} live token row(s) for ${CLIENT_ID}.`);
    }
    await execD1('DELETE FROM client_apps WHERE client_id = ?', [CLIENT_ID]);
    console.error(`Existing client deleted (status was: ${existing[0].status}). Reissuing…`);
  }

  // Generate + hash + insert
  const clientSecret = generateClientSecret();
  const clientSecretHash = await hashPassword(clientSecret);
  // Empty redirect_uris — client_credentials grant doesn't redirect (RFC 6749 §4.4)
  const redirectUris = '[]';
  // Phase 2（移除全域 admin）：細粒度 ops scope 取代籠統 admin。
  // ops:maps/poi/cache/trips:read = 維運 endpoint scope（requireScope/hasOpsScope）；
  // companion = tp-request scheduler 透過 X-Request-Scope: companion + clientId match
  // 解析 user_id 寫 poi_favorites（specs/tp-companion-mapping/spec.md）。
  const allowedScopes = '["ops:maps","ops:poi","ops:cache","ops:trips:read","companion"]';

  await execD1(
    `INSERT INTO client_apps
       (client_id, client_secret_hash, client_type, app_name, app_description,
        homepage_url, redirect_uris, allowed_scopes, owner_user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      CLIENT_ID,
      clientSecretHash,
      'confidential',
      'Tripline Internal CLI',
      'Service-to-service token for tp-request-scheduler / tripline-job / api-server',
      null,
      redirectUris,
      allowedScopes,
      ownerUserId,
      'active', // bypass pending_review — admin-provisioned
    ],
  );

  console.log('=========================================');
  console.log('Provisioned admin CLI client_app');
  console.log('=========================================');
  console.log(`TRIPLINE_API_CLIENT_ID=${CLIENT_ID}`);
  console.log(`TRIPLINE_API_CLIENT_SECRET=${clientSecret}`);
  console.log('');
  console.log('Save the secret above to your launchd plist or .env.local NOW.');
  console.log('It is NOT recoverable — DB stores only the hash.');
  console.log('');
  console.log('Verify with:');
  console.log('  TRIPLINE_API_CLIENT_ID=' + CLIENT_ID + ' \\');
  console.log('  TRIPLINE_API_CLIENT_SECRET=' + clientSecret + ' \\');
  console.log('  node scripts/lib/get-tripline-token.js');
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
