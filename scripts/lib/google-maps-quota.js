/**
 * google-maps-quota.js — Google Maps free-tier headroom + overage cost helper.
 *
 * v2.46.x: 2025/3/1 起 Maps 取消 $200 月抵免，改「每個 SKU 各自的免費月額度」
 * （Essentials 10K / Pro 5K / Enterprise 1K events/SKU/月，不共用池）。實測本專案
 * 全部用量遠在免費額度內 → 真實月花費 $0。所以監控不是「$ vs 預算」，而是
 * 「每個 SKU 用掉免費額度的 %」— 在跨入付費前預警。
 *
 * 用量來源：Cloud Monitoring `serviceruntime.../request_count` per-method counts
 * （見 functions/api/_gcp_monitoring.ts，month-to-date，與免費額度同為月週期）。
 *
 * Units:
 *   - count / usage: per-method month-to-date request count
 *   - cap: 該 SKU 每月免費額度（events）
 *   - pct: usage / cap × 100
 *   - overageCost: 超出免費額度部分的牌價成本（USD；現為 $0）
 */
'use strict';

// 每月免費額度（events per SKU），keyed by GCP consumed_api method label。
// 來源：Maps Platform 2025/3 pricing（Essentials 10K / Pro 5K / Enterprise 1K）。
// Places (New) 的 SKU tier 由 request field mask 決定（見 src/server/maps/
// google-client.ts）：SearchText / GetPlace 的 mask 含 rating / businessStatus /
// regularOpeningHours / internationalPhoneNumber → Enterprise tier → 1,000/月。
// Autocomplete、ComputeRoutes（無 routingPreference = basic）、Dynamic Maps 為
// Essentials → 10,000/月。cap 取「實際 tier」以正確預警；不確定時取較小值（% 偏高
// 是安全方向 = 早示警）。
var FREE_CAP = {
  'google.maps.places.v1.Places.SearchText': 1000, // Text Search Enterprise（rating/businessStatus）
  'google.maps.places.v1.Places.GetPlace': 1000, // Place Details Enterprise（rating/hours/phone）
  'google.maps.places.v1.Places.AutocompletePlaces': 10000, // Autocomplete Essentials
  'google.maps.routing.v2.Routes.ComputeRoutes': 10000, // Compute Routes Essentials
  'google.routes.Directions.Http': 10000, // legacy Directions
  'google.maps.BaseMap.Javascript': 10000, // Dynamic Maps Essentials
};

// 超額牌價（price per 1000 requests, USD），只在 usage > cap 時算成本。
var PRICE_PER_1K = {
  'google.maps.places.v1.Places.SearchText': 32,
  'google.maps.places.v1.Places.GetPlace': 17,
  'google.maps.places.v1.Places.AutocompletePlaces': 2.83,
  'google.maps.routing.v2.Routes.ComputeRoutes': 5,
  'google.routes.Directions.Http': 5,
  'google.maps.BaseMap.Javascript': 7,
};

var WARN_PCT = 80; // 任一 SKU 用掉 ≥80% 免費額度 → warning（跨入付費前預警）
// 任一 SKU 用掉 ≥90% 免費額度 → critical。2026-07-29 從 app_settings 的
// google_maps_lock_threshold_pct 搬來寫死 —— 那組 key 建立在 2025-03 就取消的
// $200 抵免模型上，兩端本來也都是 `|| 90` fallback。與 google-quota-monitor.ts
// 同步（drift test 守著，比照 WARN_PCT）。
var CRITICAL_PCT = 90;

/**
 * 算每個 method 的免費額度 headroom + 超額成本。
 * estimates: [{ method, count }]（month-to-date counts）。
 * 回 { items, maxPct, worst, overageCostTotal }。未知 method（cap 缺）跳過
 * headroom 但若有 price 仍可估超額（理論上不會發生，cap/price 表同步維護）。
 */
function calcHeadroom(estimates) {
  var items = estimates.map(function (e) {
    var cap = FREE_CAP[e.method] || 0;
    var price = PRICE_PER_1K[e.method] || 0;
    var pct = cap > 0 ? (e.count / cap) * 100 : 0;
    var overage = Math.max(0, e.count - cap);
    var overageCost = (overage / 1000) * price;
    return { method: e.method, usage: e.count, cap: cap, pct: pct, overageCost: overageCost };
  });
  var maxPct = 0;
  var worst = null;
  var overageCostTotal = 0;
  items.forEach(function (it) {
    overageCostTotal += it.overageCost;
    if (it.cap > 0 && it.pct > maxPct) {
      maxPct = it.pct;
      worst = it;
    }
  });
  return { items: items, maxPct: maxPct, worst: worst, overageCostTotal: overageCostTotal };
}

/** maxPct ≥ criticalPct → critical；≥ WARN_PCT → warning；else ok。 */
function classifyStatus(maxPct, criticalPct) {
  if (maxPct >= criticalPct) return 'critical';
  if (maxPct >= WARN_PCT) return 'warning';
  return 'ok';
}

module.exports = {
  FREE_CAP: FREE_CAP,
  PRICE_PER_1K: PRICE_PER_1K,
  WARN_PCT: WARN_PCT,
  CRITICAL_PCT: CRITICAL_PCT,
  calcHeadroom: calcHeadroom,
  classifyStatus: classifyStatus,
};
