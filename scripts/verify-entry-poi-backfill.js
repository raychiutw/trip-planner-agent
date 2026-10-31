#!/usr/bin/env node
/**
 * verify-entry-poi-backfill.js — Phase 2 backfill coverage assertion
 *
 * 確認 trip_entries 全部都有 poi_id（Phase 3 DROP entry.location 前的 gate）。
 * 若有任何 poi_id IS NULL 的 entry，列印明細並 exit 1。
 *
 * Usage:
 *   node scripts/verify-entry-poi-backfill.js          # 掃全部 trip
 *   node scripts/verify-entry-poi-backfill.js --trip <id>
 */

const { execSync } = require('child_process');

const DB_NAME = 'trip-planner-db';
const args = process.argv.slice(2);
const TRIP_FILTER = (() => {
  const i = args.indexOf('--trip');
  return i >= 0 && args[i + 1] && args[i + 1] !== 'all' ? args[i + 1] : null;
})();

function runD1Query(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command "${escaped}"`,
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const jsonStart = raw.indexOf('[');
  if (jsonStart < 0) return [];
  return JSON.parse(raw.slice(jsonStart))[0]?.results ?? [];
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

const whereTrip = TRIP_FILTER ? `AND d.trip_id = ${sqlString(TRIP_FILTER)}` : '';
const totalSql = `SELECT COUNT(*) AS n FROM trip_entries e JOIN trip_days d ON e.day_id = d.id WHERE 1=1 ${whereTrip}`;
const nullSql = `
  SELECT e.id, e.title, d.trip_id, d.day_num
  FROM trip_entries e
  JOIN trip_days d ON e.day_id = d.id
  WHERE e.poi_id IS NULL ${whereTrip}
  ORDER BY d.trip_id, d.day_num, e.sort_order
`.replace(/\s+/g, ' ').trim();

const totalRow = runD1Query(totalSql);
const total = totalRow[0]?.n ?? 0;

const missing = runD1Query(nullSql);

console.log(`Total entries${TRIP_FILTER ? ` (trip=${TRIP_FILTER})` : ''}: ${total}`);
console.log(`Missing poi_id: ${missing.length}`);

if (missing.length === 0) {
  console.log('\n✅ 100% entries 有 poi_id — Phase 2 backfill coverage 達標');
  process.exit(0);
}

console.log('\n⚠️ 以下 entries 仍缺 poi_id：\n');
console.log('| trip_id | day | entry_id | title |');
console.log('|---|---|---|---|');
for (const m of missing) {
  console.log(`| ${m.trip_id} | ${m.day_num} | ${m.id} | ${(m.title || '').slice(0, 40)} |`);
}
process.exit(1);
