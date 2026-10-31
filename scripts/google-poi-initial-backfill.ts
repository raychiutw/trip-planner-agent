#!/usr/bin/env bun
/**
 * google-poi-initial-backfill.ts — one-time backfill after migration 0051.
 *
 * Strategy: for each POI with place_id IS NULL, call /api/poi-search with
 * name+address to find Google place_id, then PATCH the POI + trigger refresh
 * via /api/pois/:id/enrich.
 *
 * Throttle: 50/day (autoplan T11 fix — leaves 50/day for live search + 30d refresh).
 * 150 POIs ÷ 50/day ≈ 3 days to complete.
 *
 * Run on mac mini cron OR manual:
 *   bun run backfill:google                # all POIs without place_id
 *   bun run backfill:google -- --dry-run   # show pending count, no API calls
 *   bun run backfill:google -- --limit=10  # smoke test
 *
 * Required env (.env.local on dev / ~/.tripline-cron/.env on mac mini):
 *   TRIPLINE_API_URL          (e.g. https://trip-planner-dby.pages.dev)
 *   TRIPLINE_API_TOKEN        (Bearer token for admin endpoints)
 *
 * Telegram report on completion:
 *   ✅ Backfilled N POI: X active / Y closed / Z missing
 */
import { loadCronEnv, makeApiClient, alertTelegram, sleep } from './_lib/cron-shared';

interface PoiRow {
  id: number;
  name: string;
  address: string | null;
  place_id: string | null;
}

interface BackfillStatus {
  version: number;
  pending: number;
  completed: number;
  total: number;
}

interface SearchResult {
  place_id: string;
  name: string;
}

interface EnrichResult {
  poiId: number;
  status: 'active' | 'closed' | 'missing';
  statusReason: string | null;
  rating: number | null;
}

const DAILY_QUOTA = 50;
const SLEEP_MS = 1500;

const ENV = loadCronEnv();
const api = makeApiClient(ENV);

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '0', 10) || DAILY_QUOTA : DAILY_QUOTA;

  console.log('🌐 Google POI initial backfill');
  console.log(`   API: ${ENV.apiUrl}`);
  console.log(`   Quota: ${limit}/day, throttle ${SLEEP_MS}ms between calls`);
  if (dryRun) console.log('   --dry-run: no API calls, just status check');

  const status = await api<BackfillStatus>('GET', '/api/admin/backfill-status');
  console.log(`📊 Status: ${status.completed}/${status.total} backfilled (${status.pending} pending)`);

  if (dryRun) {
    console.log('Dry run done — exit.');
    return;
  }
  if (status.pending === 0) {
    console.log('✅ Nothing to backfill — exit.');
    await alertTelegram(`✅ Backfill check: ${status.completed}/${status.total} complete, nothing pending.`);
    return;
  }

  // Fetch pending POIs (admin endpoint with cap)
  const { rows } = await api<{ rows: PoiRow[] }>(
    'GET',
    `/api/admin/pois-pending-place-id?limit=${limit}`,
  ).catch((e) => {
    console.error('Falling back to client-side query unavailable; ensure admin endpoint exists.');
    throw e;
  });

  let active = 0;
  let closed = 0;
  let missing = 0;
  let errors = 0;

  for (const poi of rows) {
    try {
      // Find place_id via search
      const query = poi.address ? `${poi.name} ${poi.address}` : poi.name;
      const { results } = await api<{ results: SearchResult[] }>(
        'GET',
        `/api/poi-search?q=${encodeURIComponent(query)}&limit=1`,
      );
      const placeId = results[0]?.place_id;
      if (!placeId) {
        missing += 1;
        await api('PATCH', `/api/pois/${poi.id}`, {
          status: 'missing',
          status_reason: 'Google Places search 找不到對應結果',
          status_checked_at: new Date().toISOString(),
        });
        console.log(`  [${poi.id}] ${poi.name} → MISSING`);
        await sleep(SLEEP_MS);
        continue;
      }

      // PATCH place_id + trigger enrich
      await api('PATCH', `/api/pois/${poi.id}`, { place_id: placeId });
      const enrich = await api<EnrichResult>('POST', `/api/pois/${poi.id}/enrich`, {});
      if (enrich.status === 'closed') closed += 1;
      else if (enrich.status === 'missing') missing += 1;
      else active += 1;
      console.log(`  [${poi.id}] ${poi.name} → ${enrich.status} (rating=${enrich.rating ?? 'n/a'})`);
    } catch (err) {
      errors += 1;
      console.error(`  [${poi.id}] ${poi.name} → ERROR: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(SLEEP_MS);
  }

  const summary = `✅ Backfilled ${rows.length} POI: ${active} active / ${closed} closed / ${missing} missing${errors ? ` (${errors} errors)` : ''}`;
  console.log(summary);
  await alertTelegram(summary);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('FATAL:', msg);
  alertTelegram(`🚨 google-poi-initial-backfill FAILED: ${msg}`);
  process.exit(1);
});
