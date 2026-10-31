#!/usr/bin/env bun
/**
 * google-quota-monitor.ts — Google Maps free-tier headroom monitor (alert-only).
 *
 * Strategy (v2.46.x):
 *   - GET /api/admin/quota-estimate → real month-to-date request_count per Maps
 *     method (GCP Cloud Monitoring ground truth; 502 if GCP unavailable)
 *   - 2025/3 起 Maps 取消 $200 抵免、改每個 SKU 各自免費月額度。監控 headroom
 *     （每個 SKU 用掉免費額度的 %），任一 SKU ≥80% 示警、≥lock_threshold_pct 紅燈。
 *   - overage cost = 超出免費額度部分的牌價（真實付費，現為 $0）。
 *   - ALERT-ONLY：不自動鎖。自動鎖 Maps = 整個服務停（503 outage），只為省免費
 *     額度邊緣的小錢不值得；真要停由 admin 手動 POST /api/admin/maps-lock。
 *
 * Required env: TRIPLINE_API_URL, TRIPLINE_API_TOKEN (this script auth).
 *   GCP creds (GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID) live on the Pages
 *   Function side — quota-estimate.ts queries Cloud Monitoring server-side.
 *
 * NOTE: 孤兒 script（npm run quota:google），未排程；daily-check.js 已整合同款
 * headroom 報告。FREE_CAP / PRICE SoT 也在這（drift test 對齊 lib/google-maps-quota.js）。
 */
import { loadCronEnv, makeApiClient, alertTelegram } from './_lib/cron-shared';

// 每月免費額度（events per SKU），keyed by GCP consumed_api method label。
// 與 scripts/lib/google-maps-quota.js 同步（drift test 守住）。tier 由 field mask
// 決定：SearchText/GetPlace → Enterprise 1K；Autocomplete/Routes/Dynamic Maps → Essentials 10K。
const FREE_CAP: Record<string, number> = {
  'google.maps.places.v1.Places.SearchText': 1000,
  'google.maps.places.v1.Places.GetPlace': 1000,
  'google.maps.places.v1.Places.AutocompletePlaces': 10000,
  'google.maps.routing.v2.Routes.ComputeRoutes': 10000,
  'google.routes.Directions.Http': 10000,
  'google.maps.BaseMap.Javascript': 10000,
};

// 超額牌價（price per 1000 requests, USD），只在 usage > cap 時算成本。
const PRICE_PER_1K: Record<string, number> = {
  'google.maps.places.v1.Places.SearchText': 32,
  'google.maps.places.v1.Places.GetPlace': 17,
  'google.maps.places.v1.Places.AutocompletePlaces': 2.83,
  'google.maps.routing.v2.Routes.ComputeRoutes': 5,
  'google.routes.Directions.Http': 5,
  'google.maps.BaseMap.Javascript': 7,
};

const WARN_PCT = 80;
// 與 scripts/lib/google-maps-quota.js 同步（drift test 守住）。2026-07-29 從
// app_settings 搬來寫死 —— 見該檔註解。
const CRITICAL_PCT = 90;

interface QuotaEstimate {
  method: string;
  count: number; // month-to-date request count (real, from GCP Cloud Monitoring)
}

const ENV = loadCronEnv();
const api = makeApiClient(ENV);

interface Worst {
  method: string;
  usage: number;
  cap: number;
  pct: number;
}

/** Per-SKU free-tier headroom + overage cost from month-to-date counts. */
function computeHeadroom(estimates: QuotaEstimate[]): {
  maxPct: number;
  worst: Worst | null;
  overageCostTotal: number;
} {
  let maxPct = 0;
  let worst: Worst | null = null;
  let overageCostTotal = 0;
  for (const e of estimates) {
    const cap = FREE_CAP[e.method] ?? 0;
    const price = PRICE_PER_1K[e.method] ?? 0;
    const pct = cap > 0 ? (e.count / cap) * 100 : 0;
    const overage = Math.max(0, e.count - cap);
    overageCostTotal += (overage / 1000) * price;
    if (cap > 0 && pct > maxPct) {
      maxPct = pct;
      worst = { method: e.method, usage: e.count, cap, pct };
    }
  }
  return { maxPct, worst, overageCostTotal };
}

async function main(): Promise<void> {
  console.log('🗺️  Google Maps free-tier headroom monitor');

  const criticalPct = CRITICAL_PCT;
  console.log(`   Critical headroom: ≥${criticalPct}% of any SKU free cap (alert-only)`);

  // Real month-to-date per-method counts. GCP 拿不到 → endpoint 回 502 → api()
  // throw → main().catch 顯示錯誤（不投射假數字）。
  const estimates = await api<QuotaEstimate[]>('GET', '/api/admin/quota-estimate');
  const { maxPct, worst, overageCostTotal } = computeHeadroom(estimates);

  const worstStr = worst
    ? `${worst.method.split('.').pop()} ${worst.pct.toFixed(0)}% (${worst.usage}/${worst.cap})`
    : 'n/a';
  const costStr = overageCostTotal > 0 ? `付費 $${overageCostTotal.toFixed(2)}` : '$0（免費額度內）';

  let icon = '🟢';
  if (maxPct >= criticalPct) icon = '🔴';
  else if (maxPct >= WARN_PCT) icon = '🟡';

  const summary = `${icon} Google Maps 免費額度: 最高 ${worstStr} · ${costStr}`;
  console.log(`   ${summary}`);

  // Alert-only：不自動鎖（鎖 = Maps 全停 503 outage，不值得為免費額度邊緣的小錢）。
  // ≥WARN_PCT 接近上限、或每月 1/15 號 → 發 Telegram 摘要。真要停由 admin 手動
  // POST /api/admin/maps-lock。
  const dayOfMonth = new Date().getDate();
  if (maxPct >= WARN_PCT || dayOfMonth === 1 || dayOfMonth === 15) {
    await alertTelegram(summary);
  }

  // Cleanup expired pois_search_cache rows so 24h-TTL table doesn't grow unbounded.
  try {
    const { deleted } = await api<{ deleted: number }>('POST', '/api/admin/cache-cleanup');
    if (deleted > 0) console.log(`🧹 Cleaned ${deleted} expired cache rows.`);
  } catch (err) {
    console.warn('Cache cleanup failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('FATAL:', msg);
  await alertTelegram(`🚨 google-quota-monitor FAILED: ${msg}`);
  process.exit(1);
});
