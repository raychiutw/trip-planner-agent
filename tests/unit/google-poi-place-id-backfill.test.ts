/**
 * #1605 一次性 place_id 回填工具。全部用假 api（含假 Google 搜尋回應），不碰真實網路。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs, estimate, type Opts } from '../../scripts/google-poi-place-id-backfill';

interface Row { id: number; name: string; address: string | null; place_id: string | null; lat?: number | null; lng?: number | null }
interface Call { method: string; path: string; body?: unknown }

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'backfill-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const baseOpts = (over: Partial<Opts> = {}): Opts => ({
  apply: false, maxCalls: 100, minSimilarity: 0.9, maxDistanceM: 150,
  searchPricePer1k: 32, detailsPricePer1k: 17, pageSize: 200, sleepMs: 0,
  statePath: join(dir, 'state.jsonl'), csvPath: join(dir, 'out.csv'), ...over,
});

const poi = (id: number, name: string, over: Partial<Row> = {}): Row => ({ id, name, address: null, place_id: null, lat: 35.0, lng: 139.0, ...over });
const hit = (place_id: string, name: string, lat = 35.0, lng = 139.0) => ({ place_id, name, address: 'x', lat, lng });

/** 假 api：rows 是待補清單、search 依 query 內含的 POI 名稱回候選。 */
function fakeApi(rows: Row[], search: Record<string, unknown[] | Error>, over: { patch?: (id: number) => unknown; enrich?: (id: number) => unknown; honorCursor?: boolean } = {}) {
  const calls: Call[] = [];
  const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body });
    if (path.startsWith('/api/admin/backfill-status')) return { pending: rows.length, completed: 0, total: rows.length } as T;
    if (path.startsWith('/api/admin/pois-pending-place-id')) {
      const u = new URL(path, 'http://x');
      const after = over.honorCursor === false ? 0 : Number(u.searchParams.get('after_id') ?? 0);
      const limit = Number(u.searchParams.get('limit'));
      return { rows: rows.filter((r) => r.id > after).slice(0, limit) } as T;
    }
    if (path.startsWith('/api/poi-search')) {
      const q = decodeURIComponent(new URL(path, 'http://x').searchParams.get('q')!);
      const key = Object.keys(search).find((k) => q.startsWith(k));
      const v = key ? search[key]! : [];
      if (v instanceof Error) throw v;
      return { results: v } as T;
    }
    if (method === 'PATCH') { const r = over.patch?.(Number(path.split('/').pop())); if (r instanceof Error) throw r; return (r ?? {}) as T; }
    if (path.endsWith('/enrich')) { const id = Number(path.split('/')[3]); const r = over.enrich?.(id); if (r instanceof Error) throw r; return (r ?? { status: 'active' }) as T; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}
const deps = (api: ReturnType<typeof fakeApi>['api']) => ({ api, sleep: async () => {}, log: (_m: string) => {} });
const logs = () => { const out: string[] = []; return { out, log: (m: string) => { out.push(m); } }; };

describe('parseArgs', () => {
  it('沒給 --apply 一律 dry-run', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--max-calls=10']).apply).toBe(false);
  });
  it('--apply 必須同時明確給 --max-calls', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/max-calls/);
    expect(parseArgs(['--apply', '--max-calls=10'])).toMatchObject({ apply: true, maxCalls: 10 });
  });
  it('保守預設與可調參數', () => {
    expect(parseArgs([])).toMatchObject({ minSimilarity: 0.9, maxDistanceM: 150 });
    expect(parseArgs(['--min-similarity=0.8', '--max-distance-m=300', '--search-price-per-1k=1', '--details-price-per-1k=2']))
      .toMatchObject({ minSimilarity: 0.8, maxDistanceM: 300, searchPricePer1k: 1, detailsPricePer1k: 2 });
  });
  it('不合法的數值與未知旗標直接拒絕', () => {
    expect(() => parseArgs(['--min-similarity=2'])).toThrow();
    expect(() => parseArgs(['--max-calls=abc'])).toThrow();
    expect(() => parseArgs(['--max-calls=0'])).toThrow();
    expect(() => parseArgs(['--aply'])).toThrow(/未知/);
  });
});

describe('estimate', () => {
  it('依單價參數算上限，不寫死', () => {
    expect(estimate(1000, { searchPricePer1k: 32, detailsPricePer1k: 17 })).toMatchObject({ searchCalls: 1000, detailsCallsMax: 1000, costUsdMax: 49 });
    expect(estimate(1000, { searchPricePer1k: 1, detailsPricePer1k: 2 }).costUsdMax).toBe(3);
  });
});

describe('dry-run（預設）', () => {
  it('完全不寫入 api、不寫 state；只輸出比對報告與 CSV', async () => {
    const f = fakeApi([poi(1, '東京鐵塔'), poi(2, '淺草寺')], { 東京鐵塔: [hit('A', '東京鐵塔')], 淺草寺: [] });
    const s = await run(baseOpts(), deps(f.api));
    expect(f.writes()).toEqual([]);
    expect(existsSync(baseOpts().statePath)).toBe(false);
    expect(s).toMatchObject({ wouldApply: 1, applied: 0, csv: 1, calls: 2, stopped: 'done' });
    expect(readFileSync(baseOpts().csvPath, 'utf8')).toContain('no-results');
  });
  it('啟動前輸出待補筆數與預估費用，並註明單價來源需核對', async () => {
    const f = fakeApi([poi(1, 'a')], {});
    const l = logs();
    await run(baseOpts(), { api: f.api, sleep: async () => {}, log: l.log });
    const head = l.out.join('\n');
    expect(head).toMatch(/待補.*1/);
    expect(head).toMatch(/USD/);
    expect(head).toMatch(/owner.*核對/);
  });
});

describe('--apply', () => {
  it('PATCH 只送 place_id，接著呼叫既有 enrich，並記錄 state', async () => {
    const f = fakeApi([poi(1, '東京鐵塔')], { 東京鐵塔: [hit('A', '東京鐵塔')] });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.writes()).toEqual([
      { method: 'PATCH', path: '/api/pois/1', body: { place_id: 'A' } },
      { method: 'POST', path: '/api/pois/1/enrich', body: {} },
    ]);
    expect(s).toMatchObject({ applied: 1, calls: 2 });
    expect(readFileSync(baseOpts().statePath, 'utf8')).toContain('"id":1');
  });
  it('已有 place_id 的列絕不寫（fill-null）', async () => {
    const f = fakeApi([poi(1, '東京鐵塔', { place_id: 'OLD' })], { 東京鐵塔: [hit('A', '東京鐵塔')] });
    await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.writes()).toEqual([]);
    expect(f.calls.some((c) => c.path.startsWith('/api/poi-search'))).toBe(false);
  });
  it('歧義 / 不同名 / 遠距離 / 缺座標 都不寫，進 CSV 並帶原因', async () => {
    const f = fakeApi(
      [poi(1, '歧義店'), poi(2, '不同名店'), poi(3, '遠店'), poi(4, '無座標店', { lat: null, lng: null })],
      { 歧義店: [hit('A', '歧義店'), hit('B', '歧義店')], 不同名店: [hit('C', '別家')], 遠店: [hit('D', '遠店', 35.1, 139)], 無座標店: [hit('E', '無座標店')] },
    );
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.writes()).toEqual([]);
    const csv = readFileSync(baseOpts().csvPath, 'utf8');
    for (const r of ['ambiguous', 'no-name-match', 'name-match-too-far', 'no-coords']) expect(csv).toContain(r);
    expect(s.csv).toBe(4);
    expect(f.calls.filter((c) => c.path.startsWith('/api/poi-search'))).toHaveLength(3); // 缺座標不花 Google 呼叫
  });
  it('兩個 POI 比到同一 place_id：第二個不寫（避免重複）', async () => {
    const f = fakeApi([poi(1, '甲'), poi(2, '甲')], { 甲: [hit('A', '甲')] });
    await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.writes().filter((w) => w.method === 'PATCH')).toHaveLength(1);
    expect(readFileSync(baseOpts().csvPath, 'utf8')).toContain('duplicate-place-id');
  });
  it('CSV 欄位轉義，且以 = + - @ 開頭的值加前綴防公式注入', async () => {
    const f = fakeApi([poi(1, '=cmd,"x"')], {});
    await run(baseOpts({ apply: true }), deps(f.api));
    const csv = readFileSync(baseOpts().csvPath, 'utf8');
    expect(csv).toContain(`"'=cmd,""x"""`);
  });
});

describe('費用上限', () => {
  it('--max-calls 以最壞情況（搜尋+enrich）預留，絕不超過', async () => {
    const rows = [1, 2, 3, 4].map((i) => poi(i, `店${i}`));
    const search = Object.fromEntries(rows.map((r) => [r.name, [hit(`P${r.id}`, r.name)]]));
    const f = fakeApi(rows, search);
    const s = await run(baseOpts({ apply: true, maxCalls: 5 }), deps(f.api));
    expect(s).toMatchObject({ applied: 2, calls: 4, stopped: 'max-calls' });
    expect(f.calls.filter((c) => c.path.startsWith('/api/poi-search')).length + f.calls.filter((c) => c.path.endsWith('/enrich')).length).toBeLessThanOrEqual(5);
  });
  it('dry-run 每筆只預留 1 次搜尋', async () => {
    const f = fakeApi([1, 2, 3].map((i) => poi(i, `店${i}`)), {});
    const s = await run(baseOpts({ maxCalls: 2 }), deps(f.api));
    expect(s).toMatchObject({ calls: 2, stopped: 'max-calls' });
  });
});

describe('續跑', () => {
  it('state 內的 id 不再處理（不再花搜尋呼叫）', async () => {
    writeFileSync(baseOpts().statePath, '{"id":1,"outcome":"applied"}\n{"id":2,"outcome":"csv"}\n');
    const f = fakeApi([poi(1, '甲'), poi(2, '乙'), poi(3, '丙')], { 丙: [hit('C', '丙')] });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.calls.filter((c) => c.path.startsWith('/api/poi-search'))).toHaveLength(1);
    expect(s.applied).toBe(1);
  });
  it('用 after_id 游標翻頁；api 不支援游標時偵測到就停（不無限迴圈）', async () => {
    const rows = [1, 2, 3].map((i) => poi(i, `店${i}`));
    const f = fakeApi(rows, {});
    const s = await run(baseOpts({ pageSize: 2 }), deps(f.api));
    expect(s.csv).toBe(3);
    const g = fakeApi(rows, {}, { honorCursor: false });
    const s2 = await run(baseOpts({ pageSize: 2 }), deps(g.api));
    expect(s2.stopped).toBe('no-cursor');
    expect(s2.csv).toBe(2);
  });
});

describe('限流與錯誤處理', () => {
  const e = (status: number, body = '') => new Error(`GET /api/poi-search?q=x → ${status}: ${body}`);
  it('搜尋 429：立即停止，該筆不記入 state（下次續跑會重試）', async () => {
    const f = fakeApi([poi(1, '甲'), poi(2, '乙')], { 甲: e(429) });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(s.stopped).toBe('rate-limited');
    expect(f.calls.filter((c) => c.path.startsWith('/api/poi-search'))).toHaveLength(1);
    expect(existsSync(baseOpts().statePath) ? readFileSync(baseOpts().statePath, 'utf8') : '').not.toContain('"id":1');
  });
  it('503（Maps kill switch）停止', async () => {
    const f = fakeApi([poi(1, '甲'), poi(2, '乙')], { 甲: e(503, 'MAPS_LOCKED') });
    expect((await run(baseOpts({ apply: true }), deps(f.api))).stopped).toBe('maps-locked');
  });
  it('單筆 502：記錄錯誤、不進 state、繼續下一筆；連續 5 筆錯誤中止', async () => {
    const f = fakeApi([poi(1, '甲'), poi(2, '乙')], { 甲: e(502) , 乙: [hit('B', '乙')] });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(s).toMatchObject({ errors: 1, applied: 1, stopped: 'done' });
    const rows = [1, 2, 3, 4, 5, 6].map((i) => poi(i, `店${i}`));
    const g = fakeApi(rows, Object.fromEntries(rows.map((r) => [r.name, e(502)])));
    const s2 = await run(baseOpts({ statePath: join(dir, 's2.jsonl'), csvPath: join(dir, 'c2.csv') }), deps(g.api));
    expect(s2).toMatchObject({ errors: 5, stopped: 'errors' });
  });
  it('401/403（token 或 scope 不對）：停止', async () => {
    const f = fakeApi([poi(1, '甲')], { 甲: e(403) });
    expect((await run(baseOpts({ apply: true }), deps(f.api))).stopped).toBe('auth');
  });
  it('PATCH 失敗：不呼叫 enrich、不進 state', async () => {
    const f = fakeApi([poi(1, '甲')], { 甲: [hit('A', '甲')] }, { patch: () => new Error('PATCH /api/pois/1 → 500: x') });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(f.calls.some((c) => c.path.endsWith('/enrich'))).toBe(false);
    expect(s).toMatchObject({ applied: 0, errors: 1 });
  });
  it('enrich 失敗：place_id 已寫入，仍記入 state（不重複花搜尋費用）', async () => {
    const f = fakeApi([poi(1, '甲')], { 甲: [hit('A', '甲')] }, { enrich: () => new Error('POST /api/pois/1/enrich → 502: x') });
    const s = await run(baseOpts({ apply: true }), deps(f.api));
    expect(s).toMatchObject({ applied: 1, enrichErrors: 1 });
    expect(readFileSync(baseOpts().statePath, 'utf8')).toContain('"id":1');
  });
});
