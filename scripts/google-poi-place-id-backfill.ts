#!/usr/bin/env bun
/**
 * google-poi-place-id-backfill.ts — #1605 B 方案：一次性回填既有 POI 的 place_id。
 *
 * 只補「能以名稱＋座標高信心比對到 Google place」的 POI；比對不到或有歧義者輸出 CSV 給人工，不寫入。
 * 預設 dry-run（會花搜尋呼叫、但不寫任何東西）；沒有明確 --apply 絕不寫入。
 *
 * 用法：
 *   bun scripts/google-poi-place-id-backfill.ts                          # dry-run，預設最多 50 次 Google 呼叫
 *   bun scripts/google-poi-place-id-backfill.ts --max-calls=200          # dry-run，放寬上限
 *   bun scripts/google-poi-place-id-backfill.ts --apply --max-calls=200  # 真的寫入（--max-calls 必須明確給）
 *
 * 旗標（皆有保守預設）：
 *   --max-calls=N               Google 計費呼叫上限（搜尋 + enrich 合計）。--apply 時必填
 *   --min-similarity=0.9        名稱相似度下限（0~1）
 *   --max-distance-m=150        座標距離上限（公尺）
 *   --search-price-per-1k=32    Text Search 單價 USD/1000 次（來源見下）
 *   --details-price-per-1k=17   Place Details 單價 USD/1000 次（來源見下）
 *   --state=PATH                續跑用的已處理 id 記錄（JSONL），預設 ./place-id-backfill-state.jsonl
 *   --csv=PATH                  人工處理清單，預設 ./place-id-backfill-unmatched.csv（dry-run 覆寫、--apply 附加）
 *
 * 單價預設值取自 trip-planner-api 的程式註解（poi-search.ts「$32/1000」、places/resolve.ts「$17/1000」），
 * 不是 Google 官方價目；實跑前 owner 必須對照 Google Maps Platform 價目表核對（SKU、免費額度、幣別）。
 *
 * 需要的 api 能力與現況（owner 實跑前必須確認，見 PR 說明）：
 *   - GET /api/admin/pois-pending-place-id 需回 lat、lng，並支援 after_id 游標（現況只回 id/name/address/place_id）。
 *     缺 lat/lng 的列一律進 CSV（no-coords）；api 不認 after_id 時第二頁起偵測到並停止（no-cursor）。
 *   - 憑證沿用 cron-shared（TRIPLINE_API_CLIENT_ID/SECRET，需 ops:poi scope）。
 *   - 搜尋走 GET /api/poi-search，該端點有 per-IP 每日上限；遇 429 即停止，隔天續跑。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decide, DEFAULT_MATCH_OPTS, type Candidate } from './lib/place-id-match';

export interface Opts {
  apply: boolean;
  maxCalls: number;
  minSimilarity: number;
  maxDistanceM: number;
  searchPricePer1k: number;
  detailsPricePer1k: number;
  pageSize: number;
  sleepMs: number;
  statePath: string;
  csvPath: string;
}

export interface Deps {
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export interface Summary {
  stopped: 'done' | 'max-calls' | 'rate-limited' | 'maps-locked' | 'auth' | 'errors' | 'no-cursor';
  calls: number;
  applied: number;
  wouldApply: number;
  csv: number;
  errors: number;
  enrichErrors: number;
}

interface PendingRow {
  id: number;
  name: string;
  address: string | null;
  place_id: string | null;
  lat?: number | null;
  lng?: number | null;
}

const MAX_CONSECUTIVE_ERRORS = 5;
const SEARCH_LIMIT = 5;

export function parseArgs(argv: string[]): Opts {
  const flags = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`未知參數：${a}`);
    flags.set(m[1]!, m[2] ?? '');
  }
  const known = ['apply', 'max-calls', 'min-similarity', 'max-distance-m', 'search-price-per-1k', 'details-price-per-1k', 'state', 'csv'];
  for (const k of flags.keys()) if (!known.includes(k)) throw new Error(`未知參數：--${k}`);

  const num = (k: string, def: number, ok: (n: number) => boolean, hint: string): number => {
    if (!flags.has(k)) return def;
    const n = Number(flags.get(k));
    if (flags.get(k) === '' || !Number.isFinite(n) || !ok(n)) throw new Error(`--${k} 需為${hint}`);
    return n;
  };
  const apply = flags.has('apply');
  if (apply && !flags.has('max-calls')) throw new Error('--apply 必須明確指定 --max-calls=N（費用上限）');
  return {
    apply,
    maxCalls: num('max-calls', 50, (n) => Number.isInteger(n) && n > 0, '正整數'),
    minSimilarity: num('min-similarity', DEFAULT_MATCH_OPTS.minSimilarity, (n) => n > 0 && n <= 1, ' 0~1 之間的數（不含 0）'),
    maxDistanceM: num('max-distance-m', DEFAULT_MATCH_OPTS.maxDistanceM, (n) => n > 0, '正數'),
    searchPricePer1k: num('search-price-per-1k', 32, (n) => n >= 0, '非負數'),
    detailsPricePer1k: num('details-price-per-1k', 17, (n) => n >= 0, '非負數'),
    pageSize: 200,
    sleepMs: 1500,
    statePath: flags.get('state') || './place-id-backfill-state.jsonl',
    csvPath: flags.get('csv') || './place-id-backfill-unmatched.csv',
  };
}

/** 最壞情況：每筆待補都搜尋一次、且全部比到而 enrich 一次。 */
export function estimate(pending: number, p: Pick<Opts, 'searchPricePer1k' | 'detailsPricePer1k'>) {
  return {
    searchCalls: pending,
    detailsCallsMax: pending,
    costUsdMax: (pending * p.searchPricePer1k + pending * p.detailsPricePer1k) / 1000,
  };
}

function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 防試算表公式注入
  return /[",\n\r]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = 'poi_id,name,address,lat,lng,reason,candidates\n';
const candText = (cs: Candidate[]) => cs.map((c) => `${c.place_id}|${c.name}`).join(' ; ');

function loadDone(path: string): Set<number> {
  const done = new Set<number>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try { const id = (JSON.parse(line) as { id?: unknown }).id; if (typeof id === 'number') done.add(id); } catch { /* 空行或半行 */ }
  }
  return done;
}

const statusOf = (e: unknown): number | null => {
  const m = /(?:→ |\()(\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
  return m ? Number(m[1]) : null;
};

export async function run(opts: Opts, deps: Deps): Promise<Summary> {
  const { api, sleep, log } = deps;
  const s: Summary = { stopped: 'done', calls: 0, applied: 0, wouldApply: 0, csv: 0, errors: 0, enrichErrors: 0 };

  const status = await api<{ pending: number; completed: number; total: number }>('GET', '/api/admin/backfill-status');
  const est = estimate(status.pending, opts);
  log(`模式：${opts.apply ? 'APPLY（會寫入）' : 'dry-run（不寫入）'}`);
  log(`待補 place_id 的 POI：${status.pending} / 全部 ${status.total}`);
  log(`預估最壞情況：Text Search ${est.searchCalls} 次 + Place Details ≤${est.detailsCallsMax} 次 ≈ USD ${est.costUsdMax.toFixed(2)}`);
  log(`單價：搜尋 ${opts.searchPricePer1k} / Details ${opts.detailsPricePer1k} USD 每千次（取自 api 程式註解，非官方價目，需 owner 核對）`);
  log(`本次上限：${opts.maxCalls} 次 Google 呼叫；比對門檻：相似度 >= ${opts.minSimilarity}、距離 <= ${opts.maxDistanceM} m`);

  const done = loadDone(opts.statePath);
  // dry-run 覆寫 CSV（可重複預覽）；apply 附加（續跑累積）
  if (!opts.apply || !existsSync(opts.csvPath)) writeFileSync(opts.csvPath, CSV_HEADER);
  const csvOut = (r: PendingRow, reason: string, cands: Candidate[] = []) => {
    appendFileSync(opts.csvPath, [r.id, r.name, r.address, r.lat, r.lng, reason, candText(cands)].map(csvCell).join(',') + '\n');
    s.csv += 1;
  };
  const markDone = (id: number, outcome: 'applied' | 'csv') => {
    if (opts.apply) appendFileSync(opts.statePath, JSON.stringify({ id, outcome, at: new Date().toISOString() }) + '\n');
  };

  const needPerPoi = opts.apply ? 2 : 1; // 最壞情況：搜尋 + enrich
  const usedPlaceIds = new Set<string>();
  let cursor = 0;
  let consecutiveErrors = 0;

  for (;;) {
    let page: PendingRow[];
    try {
      ({ rows: page } = await api<{ rows: PendingRow[] }>('GET', `/api/admin/pois-pending-place-id?limit=${opts.pageSize}&after_id=${cursor}`));
    } catch (e) {
      const st = statusOf(e);
      if (st === 401 || st === 403) { s.stopped = 'auth'; return s; }
      throw e;
    }
    const rows = page.filter((r) => r.id > cursor);
    if (rows.length === 0) {
      if (page.length > 0) { log('api 未支援 after_id 游標（回傳的列都已處理過），停止以免重複花費'); s.stopped = 'no-cursor'; }
      return s;
    }

    for (const r of rows) {
      cursor = r.id;
      if (done.has(r.id) || r.place_id) continue; // 已處理 / fill-null：已有值絕不碰

      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || r.lat == null || r.lng == null) {
        csvOut(r, 'no-coords'); markDone(r.id, 'csv'); continue;
      }
      if (s.calls + needPerPoi > opts.maxCalls) { log(`達 --max-calls=${opts.maxCalls}，停止（續跑會從 state 接續）`); s.stopped = 'max-calls'; return s; }

      try {
        const q = r.address ? `${r.name} ${r.address}` : r.name;
        s.calls += 1;
        const { results } = await api<{ results: Candidate[] }>('GET', `/api/poi-search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
        const d = decide({ name: r.name, lat: r.lat, lng: r.lng }, results ?? [], opts);

        if (d.kind === 'ambiguous') { csvOut(r, 'ambiguous', d.candidates); markDone(r.id, 'csv'); }
        else if (d.kind === 'none') { csvOut(r, d.reason, results ?? []); markDone(r.id, 'csv'); }
        else if (usedPlaceIds.has(d.candidate.place_id)) { csvOut(r, 'duplicate-place-id', [d.candidate]); markDone(r.id, 'csv'); }
        else {
          usedPlaceIds.add(d.candidate.place_id);
          if (!opts.apply) {
            s.wouldApply += 1;
            log(`  [${r.id}] ${r.name} → 會寫入 ${d.candidate.place_id}（相似度 ${d.similarity.toFixed(2)}、${Math.round(d.distanceM)} m）`);
          } else {
            // 只送 place_id 一個欄位；列來自 place_id IS NULL 的清單（fill-null）
            await api('PATCH', `/api/pois/${r.id}`, { place_id: d.candidate.place_id });
            s.applied += 1;
            markDone(r.id, 'applied');
            try {
              s.calls += 1;
              await api('POST', `/api/pois/${r.id}/enrich`, {});
            } catch (e) {
              s.enrichErrors += 1;
              log(`  [${r.id}] enrich 失敗（place_id 已寫入，30 天更新會補）：${e instanceof Error ? e.message : e}`);
            }
          }
        }
        consecutiveErrors = 0;
      } catch (e) {
        const st = statusOf(e);
        if (st === 429) { log('Google／api 限流（429），停止；稍後用同一個 --state 續跑'); s.stopped = 'rate-limited'; return s; }
        if (st === 503) { log('Maps 被 kill switch 鎖定（503），停止'); s.stopped = 'maps-locked'; return s; }
        if (st === 401 || st === 403) { s.stopped = 'auth'; return s; }
        s.errors += 1;
        consecutiveErrors += 1;
        log(`  [${r.id}] ${r.name} → ERROR：${e instanceof Error ? e.message : e}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { log(`連續 ${MAX_CONSECUTIVE_ERRORS} 筆錯誤，中止`); s.stopped = 'errors'; return s; }
      }
      await sleep(opts.sleepMs);
    }
    if (page.length < opts.pageSize) return s;
  }
}

if (import.meta.main) {
  (async () => {
    const { loadCronEnv, makeApiClient, sleep } = await import('./_lib/cron-shared');
    const opts = parseArgs(process.argv.slice(2));
    const api = makeApiClient(loadCronEnv());
    const s = await run(opts, { api, sleep, log: (m) => console.log(m) });
    console.log(`結束（${s.stopped}）：Google 呼叫 ${s.calls}、${opts.apply ? `已寫入 ${s.applied}` : `可寫入 ${s.wouldApply}`}、進 CSV ${s.csv}、錯誤 ${s.errors}`);
    console.log(`人工清單：${opts.csvPath}`);
    if (s.stopped === 'auth' || s.stopped === 'errors') process.exit(1);
  })().catch((e) => { console.error('FATAL:', e instanceof Error ? e.message : e); process.exit(1); });
}
