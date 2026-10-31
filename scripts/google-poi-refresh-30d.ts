#!/usr/bin/env bun
/**
 * google-poi-refresh-30d.ts — daily 30d refresh of POI lifecycle.
 *
 * Triggered by:
 *   - launchd com.tripline.daily-check (mac mini cron)
 *   - Manual: bun run refresh:google
 *
 * Strategy: SELECT pois WHERE place_id IS NOT NULL AND status='active'
 *   AND (last_refreshed_at IS NULL OR < now-30d) ORDER BY last_refreshed_at ASC
 *   LIMIT 50 (autoplan T11 50/day cap). Call Place Details → write
 *   rating + status + status_reason + last_refreshed_at.
 *
 * First-call 401 → Telegram alert + exit non-zero (autoplan T15 fix).
 *
 * Required env: TRIPLINE_API_URL + TRIPLINE_API_TOKEN
 *
 * Telegram daily summary:
 *   📊 Refresh: 50 POI checked / 47 active / 2 closed / 1 missing
 */
import { loadCronEnv, makeApiClient, alertTelegram, sleep } from './_lib/cron-shared';

interface PoiRow {
  id: number;
  name: string;
  place_id: string;
}

interface EnrichResult {
  poi_id: number;
  status: 'active' | 'closed' | 'missing';
  rating: number | null;
}

const DAILY_QUOTA = 50;
const SLEEP_MS = 1500;
// v2.33.91 simplify: 平行 4 個 enrich + sleep 一次 = ~3 req/s effective rate
// 對齊 Google 軟限 hint。原 sequential 50 × 1.5s = 75s → batch=4 約 18-20s。
const BATCH_SIZE = 4;

const ENV = loadCronEnv();
const api = makeApiClient(ENV);

async function main(): Promise<void> {
  console.log('🔁 Google POI 30d refresh');

  const { rows } = await api<{ rows: PoiRow[] }>(
    'GET',
    `/api/admin/pois-due-refresh?limit=${DAILY_QUOTA}`,
  );

  if (rows.length === 0) {
    console.log('✅ No POIs due for refresh today.');
    return;
  }
  console.log(`Refreshing ${rows.length} POI...`);

  let active = 0;
  let closed = 0;
  let missing = 0;

  // v2.33.91 simplify: batched parallel enrich + per-batch sleep。
  // First batch 序列跑（檢測 first-call 401 用 autoplan T15）。後續 batch
  // 平行 4 個 + 1.5s sleep 維持 ~3 req/s 對齊 Google 軟限。
  // first-call 401 → likely env misconfig，alert + exit。
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const isFirstBatch = i === 0;
    const settled = await Promise.allSettled(
      batch.map((poi) => api<EnrichResult>('POST', `/api/pois/${poi.id}/enrich`, {})),
    );
    for (let j = 0; j < settled.length; j++) {
      const poi = batch[j]!;
      const r = settled[j]!;
      if (r.status === 'fulfilled') {
        if (r.value.status === 'closed') closed += 1;
        else if (r.value.status === 'missing') missing += 1;
        else active += 1;
        console.log(`  [${poi.id}] ${poi.name} → ${r.value.status}`);
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        // 精準比對 status-position 401（`→ 401` / `(401)`），避開 path 內的 "401" 子字串：
        // makeApiClient fail-loud 訊息含 path，POI id 含 401（如 1401）遇空-body 200 會誤判成
        // API key rejected。順帶修既有 non-ok 訊息同款 substring 脆弱性。
        if (isFirstBatch && (/(?:→ |\()401\b/.test(msg) || /unauthorized/i.test(msg))) {
          const alert = '[tp-cron] GOOGLE_MAPS_API_KEY rejected — 檢查 ~/.tripline-cron/.env';
          console.error(alert);
          await alertTelegram(alert);
          process.exit(1);
        }
        console.error(`  [${poi.id}] ${poi.name} → ERROR: ${msg}`);
      }
    }
    if (i + BATCH_SIZE < rows.length) await sleep(SLEEP_MS);
  }

  const summary = `📊 Refresh: ${rows.length} POI checked / ${active} active / ${closed} closed / ${missing} missing`;
  console.log(summary);
  await alertTelegram(summary);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('FATAL:', msg);
  alertTelegram(`🚨 google-poi-refresh-30d FAILED: ${msg}`);
  process.exit(1);
});
