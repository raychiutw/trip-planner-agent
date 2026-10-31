#!/usr/bin/env node
/**
 * cleanup-test-data-leak.js — mockup-parity-qa-fixes Sprint 7.1
 *
 * v2 deeper QA 在 prod Ray's trip Day 04 看到 `TEST_AUTO_UPDATE_PROBE` × 2 entry leak。
 * 此 script DELETE 所有含 `TEST_AUTO_UPDATE_PROBE` / `_PROBE` / `AUTO_TEST_FIXTURE` 的
 * trip_entries，避免影響 user 體驗。
 *
 * Usage:
 *   node scripts/cleanup-test-data-leak.js [--dry-run] [--marker=TEST_AUTO_UPDATE_PROBE]
 *
 * Default behavior：dry-run（列出要刪的 entry，不實際 DELETE）。要真刪加 `--no-dry-run`。
 *
 * 環境變數：
 *   TRIPLINE_API_CLIENT_ID + TRIPLINE_API_CLIENT_SECRET （從 .env.local 自動讀）
 *   TRIPLINE_API_BASE （default https://trip-planner-dby.pages.dev）
 */
'use strict';

const { getToken } = require('./lib/get-tripline-token');

const BASE = process.env.TRIPLINE_API_BASE || 'https://trip-planner-dby.pages.dev';
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--no-dry-run');
const MARKER = (args.find((a) => a.startsWith('--marker=')) || '--marker=TEST_AUTO_UPDATE_PROBE').slice(9);

async function main() {
  console.log('cleanup-test-data-leak.js — DRY_RUN=' + DRY_RUN + ' MARKER=' + MARKER);

  const token = await getToken();

  // 1) 列出所有 trips
  const tripsRes = await fetch(BASE + '/api/trips?all=1', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (!tripsRes.ok) {
    throw new Error('GET /api/trips failed: ' + tripsRes.status);
  }
  const trips = await tripsRes.json();
  console.log('Found ' + trips.length + ' trips total.');

  let totalLeaks = 0;
  let totalDeleted = 0;

  for (const trip of trips) {
    const tripId = trip.tripId;
    // 2) 拿 trip 的 days?all=1（含 timeline + entries embedded）
    const daysRes = await fetch(BASE + '/api/trips/' + encodeURIComponent(tripId) + '/days?all=1', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!daysRes.ok) {
      console.warn('  GET days?all=1 failed for ' + tripId + ': ' + daysRes.status);
      continue;
    }
    const days = await daysRes.json();

    for (const day of days) {
      const dayNum = day.dayNum || day.day_num;
      const timeline = day.timeline || day.entries || [];

      for (const entry of timeline) {
        // migration 0078：entry-level note 欄位已 DROP，備註改掛 per-POI。
        // `?all=1` 回 deepCamel'd stopPois（sortOrder），master 為 sortOrder===1。
        const masterNote =
          (entry.stopPois || []).find((p) => (p.sortOrder ?? p.sort_order) === 1)?.note || '';
        const text = (entry.title || '') + ' ' + masterNote;
        if (text.indexOf(MARKER) >= 0) {
          totalLeaks++;
          console.log(
            '  LEAK: trip=' + tripId + ' day=' + dayNum + ' entry=' + entry.id +
            ' title="' + (entry.title || '').slice(0, 40) + '"'
          );
          if (!DRY_RUN) {
            const delRes = await fetch(
              BASE + '/api/trips/' + encodeURIComponent(tripId) + '/entries/' + entry.id,
              { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } }
            );
            if (delRes.ok) {
              totalDeleted++;
              console.log('    ✓ DELETED');
            } else {
              console.warn('    ✗ DELETE failed: ' + delRes.status);
            }
          }
        }
      }
    }
  }

  console.log('\nSummary:');
  console.log('  Found ' + totalLeaks + ' leak entries containing "' + MARKER + '"');
  if (DRY_RUN) {
    console.log('  DRY_RUN — no deletes performed. Re-run with --no-dry-run to actually delete.');
  } else {
    console.log('  Deleted: ' + totalDeleted + ' / ' + totalLeaks);
  }
}

main().catch((err) => {
  console.error('cleanup failed:', err);
  process.exit(1);
});
