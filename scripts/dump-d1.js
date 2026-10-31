#!/usr/bin/env node
// Dump all D1 trip data tables to backups/ directory
//
// v2.30.8: table list 對齊 v2.30 schema 現況：
//   removed: trip_pois (DROPPED v2.29.0), saved_pois (DROPPED v2.29.1)
//   added:   trip_entry_pois (v2.27.0), trip_segments, trip_destinations,
//            trip_invitations, poi_favorites (v2.22.0 rename), users (V2 OAuth),
//            companion_request_actions (v2.22.0)
// 不含 ephemeral infra (api_logs / pois_search_cache / rate_limit_buckets /
// oauth_models / session_devices / auth_audit_log / auth_identities / client_apps /
// error_reports / app_settings) — 純 cache / log / config，無 user-data 價值
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const tables = [
  // Core trip data
  'trips', 'trip_days', 'trip_entries', 'trip_entry_pois', 'trip_segments', 'trip_destinations',
  // POI data
  'pois', 'poi_relations', 'poi_favorites',
  // Documents
  // Collaboration
  'trip_requests', 'trip_permissions', 'trip_invitations', 'companion_request_actions',
  // Audit + users
  'audit_log', 'users',
];
const backupDir = path.join(__dirname, '..', 'backups');

// v2.33.51 round 8c security: backup dir 含 users 表 PII，要 0700 (owner only)。
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(backupDir, 0o700); } catch { /* best-effort */ }

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const snapshotDir = path.join(backupDir, timestamp);
fs.mkdirSync(snapshotDir, { recursive: true });

console.log(`Dumping D1 data to ${snapshotDir}\n`);

const summary = {};

for (const table of tables) {
  try {
    const raw = execSync(
      `npx wrangler d1 execute trip-planner-db --remote --command "SELECT * FROM ${table};" --json`,
      { encoding: 'utf8', timeout: 30000 }
    );
    // wrangler --json outputs wrangler banner lines before JSON, find the JSON array
    const jsonStart = raw.indexOf('[');
    const parsed = JSON.parse(raw.slice(jsonStart));
    const rows = parsed[0]?.results || [];
    // v2.33.51 round 8c security: write JSON with 0600 (owner read/write only)
    fs.writeFileSync(path.join(snapshotDir, `${table}.json`), JSON.stringify(rows, null, 2), { mode: 0o600 });
    summary[table] = rows.length;
    console.log(`  ✓ ${table}: ${rows.length} rows`);
  } catch (err) {
    console.error(`  ✗ ${table}: ${err.message}`);
    summary[table] = 'ERROR';
  }
}

// Write summary
fs.writeFileSync(path.join(snapshotDir, '_summary.json'), JSON.stringify({ timestamp, summary }, null, 2));
console.log(`\nDone! Summary: ${JSON.stringify(summary)}`);
