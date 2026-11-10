/**
 * daily-check.js — 各來源 ok／warning／critical 狀態分類（issue #5 已知限制）。
 *
 * 全部走 createCheckSources(io) 的注入縫：假 queryD1／fetch／execSync／fs／now／env，
 * 不碰真實網路、D1、檔案與 process.env。
 * 邊界值寫死數字（4／5、200／201 …），不用實作常數當期望值，避免常數與判斷一起漂移而測不出。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { createCheckSources } = require('../../scripts/daily-check.js');
const { runOperations } = require('../../scripts/lib/operations-run');

const NOW = new Date('2026-11-10T00:00:00.000Z');
const mk = (io: Record<string, unknown> = {}) => createCheckSources({ env: {}, now: () => NOW, ...io });

afterEach(() => vi.restoreAllMocks());

describe('apiErrors 分類', () => {
  const run = (rows: Array<{ status: number; count: number }>) =>
    mk({ queryD1: async () => rows.map((r) => ({ path: '/api/x', method: 'GET', ...r })) }).apiErrors.run();

  it('無資料 → ok', async () => {
    expect(await run([])).toMatchObject({ status: 'ok', total: 0 });
  });
  it('僅 4xx 且總數 4 → ok（門檻下一格）', async () => {
    expect(await run([{ status: 404, count: 4 }])).toMatchObject({ status: 'ok', total: 4 });
  });
  it('僅 4xx 且總數 5 → warning（門檻本身）', async () => {
    expect(await run([{ status: 404, count: 5 }])).toMatchObject({ status: 'warning', total: 5 });
  });
  it('總數跨多列加總：3+1 → ok、3+2 → warning', async () => {
    expect(await run([{ status: 400, count: 3 }, { status: 404, count: 1 }])).toMatchObject({ status: 'ok', total: 4 });
    expect(await run([{ status: 400, count: 3 }, { status: 404, count: 2 }])).toMatchObject({ status: 'warning', total: 5 });
  });
  it('單筆 500 → critical（不論總數；499 不算 5xx）', async () => {
    expect(await run([{ status: 500, count: 1 }])).toMatchObject({ status: 'critical', total: 1 });
    expect(await run([{ status: 499, count: 1 }])).toMatchObject({ status: 'ok', total: 1 });
  });
  it('5xx 混在大量 4xx 中仍 critical；502／503 亦同', async () => {
    expect(await run([{ status: 404, count: 50 }, { status: 503, count: 1 }])).toMatchObject({ status: 'critical' });
    expect(await run([{ status: 502, count: 1 }])).toMatchObject({ status: 'critical' });
  });
  it('assess 的 severity 取自 status、completion 為 complete', () => {
    const s = mk().apiErrors;
    expect(s.assess({ status: 'critical', total: 1 })).toMatchObject({ severity: 'critical', completion: 'complete' });
    expect(s.assess({ status: 'warning', total: 5 })).toMatchObject({ severity: 'warning', completion: 'complete' });
    expect(s.assess({ status: 'ok', total: 0 })).toMatchObject({ severity: 'ok', completion: 'complete' });
  });
});

describe('routeHealth 分類', () => {
  // ROUTES 目前 6 條 → ceil(6/2)=3：失敗 2 → warning、3 → critical。
  // 先用 ok 探測拿到實際路由數，邊界從實際長度算，ROUTES 增減時失敗訊息能指出原因。
  const probe = async () => (await mk({ fetch: async () => ({ status: 200 }) }).routeHealth.run()).checked as number;
  // 前 k 條回 `bad`，其餘 200
  const runFail = async (k: number, bad: 'throw' | number) => {
    let i = 0;
    const fetch = vi.fn(async () => {
      const mine = i++;
      if (mine < k) { if (bad === 'throw') throw new Error('boom'); return { status: bad }; }
      return { status: 200 };
    });
    return mk({ fetch }).routeHealth.run();
  };

  it('ROUTES 長度為 6（邊界依此而定；變動時請同步檢視下列測試）', async () => {
    expect(await probe()).toBe(6);
  });
  it('0 失敗 → ok、complete', async () => {
    const r = await runFail(0, 500);
    expect(r).toMatchObject({ status: 'ok', total: 0, completion: 'complete', checked: 6 });
  });
  it('失敗 2（< ceil(6/2)）→ warning', async () => {
    expect(await runFail(2, 500)).toMatchObject({ status: 'warning', total: 2 });
  });
  it('失敗 3（= ceil(6/2)）→ critical', async () => {
    expect(await runFail(3, 500)).toMatchObject({ status: 'critical', total: 3 });
  });
  it('失敗 1 → warning、全失敗 → critical', async () => {
    expect(await runFail(1, 500)).toMatchObject({ status: 'warning', total: 1 });
    expect(await runFail(6, 500)).toMatchObject({ status: 'critical', total: 6 });
  });
  it('status 499 算健康、500 算失敗（< 500 為 ok）', async () => {
    expect(await runFail(1, 499)).toMatchObject({ status: 'ok', total: 0 });
    expect(await runFail(1, 500)).toMatchObject({ status: 'warning', total: 1 });
  });
  it('fetch 丟錯 → 該路由 status 0 且 ok false、帶 error', async () => {
    const r = await runFail(1, 'throw');
    expect(r.routes[0]).toMatchObject({ status: 0, ok: false, error: 'boom' });
    expect(r.routes[1]).toMatchObject({ status: 200, ok: true });
    expect(r).toMatchObject({ status: 'warning', total: 1 });
  });
  it('丟的不是 Error（無 message）→ 以 String() 當 error', async () => {
    const r = await mk({ fetch: async () => { throw 'plain'; } }).routeHealth.run(); // eslint-disable-line no-throw-literal
    expect(r.routes[0]).toMatchObject({ status: 0, ok: false, error: 'plain' });
  });
  it('completion 三態：無丟錯 complete／部分丟錯 partial／全丟錯 failed', async () => {
    expect((await runFail(0, 'throw')).completion).toBe('complete');
    expect((await runFail(1, 'throw')).completion).toBe('partial');
    expect((await runFail(5, 'throw')).completion).toBe('partial');
    const all = await runFail(6, 'throw');
    expect(all.completion).toBe('failed');
    expect(all.status).toBe('critical');
  });
  it('5xx 回應不是丟錯：status 失敗但 completion 仍 complete', async () => {
    const r = await runFail(6, 503);
    expect(r).toMatchObject({ status: 'critical', completion: 'complete' });
  });
  it('assess 帶出來源自訂的 completion 與 severity', () => {
    const s = mk().routeHealth;
    expect(s.assess({ status: 'critical', completion: 'failed' })).toMatchObject({ severity: 'critical', completion: 'failed' });
    expect(s.assess({ status: 'warning', completion: 'partial' })).toMatchObject({ severity: 'warning', completion: 'partial' });
  });
});

describe('npmAudit 分類', () => {
  const audit = (vulnerabilities: Record<string, { severity: string }>) =>
    mk({ execSync: () => JSON.stringify({ vulnerabilities }) }).npmAudit.run();

  it('無漏洞 → ok', async () => {
    expect(await audit({})).toMatchObject({ status: 'ok', total: 0 });
  });
  it('只有 info 等級不計入 → ok', async () => {
    expect(await audit({ a: { severity: 'info' } })).toMatchObject({ status: 'ok', total: 0 });
  });
  it('只有 low → warning', async () => {
    expect(await audit({ a: { severity: 'low' } })).toMatchObject({ status: 'warning', total: 1 });
  });
  it('只有 moderate → warning', async () => {
    expect(await audit({ a: { severity: 'moderate' } })).toMatchObject({ status: 'warning', total: 1 });
  });
  it('moderate 與 low 並存仍 warning', async () => {
    expect(await audit({ a: { severity: 'low' }, b: { severity: 'moderate' } })).toMatchObject({ status: 'warning', total: 2 });
  });
  it('有 high → critical', async () => {
    expect(await audit({ a: { severity: 'high' } })).toMatchObject({ status: 'critical', total: 1, severityCounts: { high: 1, critical: 0 } });
  });
  it('有 critical → critical', async () => {
    expect(await audit({ a: { severity: 'critical' } })).toMatchObject({ status: 'critical', total: 1, severityCounts: { critical: 1, high: 0 } });
  });
  it('high 混在一堆 low 中仍 critical', async () => {
    expect(await audit({ a: { severity: 'low' }, b: { severity: 'high' } })).toMatchObject({ status: 'critical' });
  });

  describe('執行失敗 fail loud', () => {
    const failing = (execSync: () => string) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      return mk({ execSync }).npmAudit.run();
    };
    it('execSync 丟錯 → critical 並帶 error，assess 為 failed／critical', async () => {
      const r = await failing(() => { throw new Error('ETIMEDOUT'); });
      expect(r).toMatchObject({ status: 'critical', total: 0 });
      expect(r.error).toContain('npm audit 執行失敗: ETIMEDOUT');
      expect(mk().npmAudit.assess(r)).toMatchObject({ completion: 'failed', severity: 'critical' });
    });
    it('輸出為空、缺 vulnerabilities、或 parsed.error → 同樣 critical', async () => {
      for (const out of ['', '   ', '{}', JSON.stringify({ error: { code: 'ENOAUDIT' } }), JSON.stringify({ vulnerabilities: 'x' })]) {
        const r = await failing(() => out);
        expect(r, out).toMatchObject({ status: 'critical' });
        expect(r.error, out).toContain('npm audit 執行失敗');
      }
    });
    it('輸出非 JSON → critical', async () => {
      expect(await failing(() => 'not json')).toMatchObject({ status: 'critical' });
    });
    it('failureSeverity 為 critical：run 本身 throw 時 runOperations 記為 critical／failed', async () => {
      const src = mk().npmAudit;
      expect(src.failureSeverity).toBe('critical');
      const out = await runOperations({ npmAudit: { ...src, run: () => { throw new Error('x'); } } });
      expect(out.sources.npmAudit).toMatchObject({ completion: 'failed', severity: 'critical' });
    });
    it('對照：沒有 failureSeverity 的來源 run 丟錯時是 warning', async () => {
      const src = mk({ queryD1: async () => { throw new Error('d1'); } }).apiErrors;
      expect(src.failureSeverity).toBeUndefined();
      const out = await runOperations({ apiErrors: src });
      expect(out.sources.apiErrors).toMatchObject({ completion: 'failed', severity: 'warning' });
    });
  });
});

// 邊界由 SQL 的 HAVING 決定，所以用 in-memory SQLite 真的跑，不用假回傳值。
describe('auditAnomaly 分類', () => {
  type Ev = { user?: number | null; trip?: string; table?: string; action?: string; n: number };
  function runAudit(events: Ev[]) {
    const db = new DatabaseSync(':memory:');
    db.exec(
      "CREATE TABLE audit_log (id INTEGER PRIMARY KEY, trip_id TEXT NOT NULL, table_name TEXT, action TEXT, changed_by TEXT, changed_by_user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    const ins = db.prepare('INSERT INTO audit_log (trip_id, table_name, action, changed_by, changed_by_user_id) VALUES (?, ?, ?, ?, ?)');
    for (const e of events) {
      for (let i = 0; i < e.n; i++) ins.run(e.trip ?? 'system', e.table ?? 'trip_entries', e.action ?? 'update', 'a', e.user ?? null);
    }
    const sources = mk({ queryD1: async (sql: string) => db.prepare(sql).all() });
    return sources.auditAnomaly.run();
  }

  it('皆無 → ok', async () => {
    expect(await runAudit([])).toMatchObject({ status: 'ok', heavyUsers: [], heavyTrips: [], criticalDeletes: [] });
  });
  it('刪除 trips 10 筆（= AUDIT_DELETE_CRITICAL）→ 仍 ok', async () => {
    expect(await runAudit([{ table: 'trips', action: 'delete', n: 10 }])).toMatchObject({ status: 'ok', criticalDeletes: [] });
  });
  it('刪除 trips 11 筆 → critical', async () => {
    expect(await runAudit([{ table: 'trips', action: 'delete', n: 11 }])).toMatchObject({
      status: 'critical',
      criticalDeletes: [{ tableName: 'trips', deletes: 11 }],
    });
  });
  it('刪除 users 11 筆 → critical；其他表的刪除不算', async () => {
    expect(await runAudit([{ table: 'users', action: 'delete', n: 11 }])).toMatchObject({ status: 'critical' });
    expect(await runAudit([{ table: 'trip_entries', action: 'delete', n: 50 }])).toMatchObject({ status: 'ok' });
  });
  it('非 delete 動作不算刪除', async () => {
    expect(await runAudit([{ table: 'trips', action: 'update', n: 11 }])).toMatchObject({ status: 'ok' });
  });
  it('同一 user 200 筆 → ok、201 筆 → warning', async () => {
    expect(await runAudit([{ user: 7, n: 200 }])).toMatchObject({ status: 'ok', heavyUsers: [] });
    expect(await runAudit([{ user: 7, n: 201 }])).toMatchObject({ status: 'warning', heavyUsers: [{ userId: 7, mutations: 201 }] });
  });
  it('同一 trip 100 筆 → ok、101 筆 → warning；system trip 不算', async () => {
    expect(await runAudit([{ trip: 't1', n: 100 }])).toMatchObject({ status: 'ok', heavyTrips: [] });
    expect(await runAudit([{ trip: 't1', n: 101 }])).toMatchObject({ status: 'warning', heavyTrips: [{ tripId: 't1', mutations: 101 }] });
    expect(await runAudit([{ trip: 'system', n: 300 }])).toMatchObject({ status: 'ok' });
  });
  it('service token（user 為 NULL）不計入 heavyUsers', async () => {
    expect(await runAudit([{ user: null, trip: 'system', n: 300 }])).toMatchObject({ status: 'ok', heavyUsers: [] });
  });
  it('critical 與 warning 並存時取 critical', async () => {
    expect(await runAudit([{ user: 7, n: 201 }, { table: 'users', action: 'delete', n: 11 }])).toMatchObject({ status: 'critical' });
  });
  it('門檻值寫進回傳（200／100／10）', async () => {
    expect((await runAudit([])).thresholds).toEqual({ userMutationWarning: 200, tripMutationWarning: 100, deleteCritical: 10 });
  });
  it('assess 的 severity 取自 status', () => {
    const s = mk().auditAnomaly;
    for (const st of ['ok', 'warning', 'critical']) expect(s.assess({ status: st })).toMatchObject({ severity: st, completion: 'complete' });
  });
});

describe('sentry 分類', () => {
  const run = (body: unknown[], ok = true) =>
    mk({ fetch: async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) }).sentry.run();

  it('無 issue → ok', async () => {
    expect(await run([])).toMatchObject({ status: 'ok', total: 0 });
  });
  it('1 個 issue → warning（不分嚴重度）', async () => {
    expect(await run([{ id: '1', title: 't', count: '3', userCount: 2 }])).toMatchObject({
      status: 'warning',
      total: 1,
      issues: [{ id: '1', count: 3, users: 2 }],
    });
  });
  it('多個 issue 仍是 warning、不升 critical', async () => {
    const r = await run(Array.from({ length: 30 }, (_, i) => ({ id: String(i), title: 't', count: '1' })));
    expect(r).toMatchObject({ status: 'warning', total: 30 });
  });
  it('API 非 2xx → run 丟錯（交由 operations-run 記為 failed／warning）', async () => {
    await expect(run([], false)).rejects.toThrow('Sentry API failed: 500');
    const out = await runOperations({ sentry: mk({ fetch: async () => ({ ok: false, status: 500 }) }).sentry });
    expect(out.sources.sentry).toMatchObject({ completion: 'failed', severity: 'warning' });
  });
});

describe('dataHygiene 分類', () => {
  it('無洩漏（空陣列或 null）→ ok', async () => {
    expect(await mk({ queryD1: async () => [] }).dataHygiene.run()).toMatchObject({ status: 'ok', total: 0, leaks: [] });
    expect(await mk({ queryD1: async () => null }).dataHygiene.run()).toMatchObject({ status: 'ok', total: 0 });
  });
  it('有洩漏 → warning，並標出命中的 marker（description 或 note）', async () => {
    const r = await mk({
      queryD1: async () => [
        { id: 1, trip_id: 't', day_num: 4, title: 'x TEST_AUTO_UPDATE_PROBE', note: null },
        { id: 2, trip_id: 't', day_num: 5, title: 'clean', note: 'has __TEST_ONLY__' },
      ],
    }).dataHygiene.run();
    expect(r).toMatchObject({ status: 'warning', total: 2 });
    expect(r.leaks.map((l: { marker: string }) => l.marker)).toEqual(['TEST_AUTO_UPDATE_PROBE', '__TEST_ONLY__']);
  });
  it('查詢本身失敗 → warning 帶 error（不假裝綠燈），assess 為 failed／warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = mk({ queryD1: async () => { throw new Error('d1 down'); } }).dataHygiene;
    const r = await s.run();
    expect(r).toMatchObject({ status: 'warning', total: 0, error: 'd1 down' });
    expect(s.assess(r)).toMatchObject({ completion: 'failed', severity: 'warning', error: 'd1 down' });
  });
});

describe('schedulerErrors 分類', () => {
  const HOUR = 3600 * 1000;
  type Stat = { size: number; mtime: Date };
  function fsWith(stat: Stat | Error, content = '') {
    return {
      statSync: () => { if (stat instanceof Error) throw stat; return stat; },
      openSync: () => 3,
      readSync: (_fd: number, buf: Buffer) => { Buffer.from(content).copy(buf); },
      closeSync: () => {},
    };
  }
  const run = (stat: Stat | Error, content = '') => mk({ fs: fsWith(stat, content) }).schedulerErrors.run();
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });

  it('log 檔不存在（ENOENT）→ ok，且不記為掃描錯誤', async () => {
    const r = await run(enoent);
    expect(r).toMatchObject({ status: 'ok', total: 0 });
    expect(r.error).toBeUndefined();
  });
  it('空檔（size 0）→ ok', async () => {
    expect(await run({ size: 0, mtime: NOW })).toMatchObject({ status: 'ok', total: 0 });
  });
  it('24h 內有寫入 → warning，取檔尾最後一行', async () => {
    const content = 'old\nlast line err';
    const r = await run({ size: content.length, mtime: new Date(NOW.getTime() - HOUR) }, content);
    expect(r).toMatchObject({ status: 'warning', total: 1 });
    expect(r.details['api-server'].errors[0].message).toBe('last line err');
  });
  it('mtime 剛好 24h 前（= cutoff）→ 仍算（>=）', async () => {
    expect(await run({ size: 3, mtime: new Date(NOW.getTime() - 24 * HOUR) }, 'err')).toMatchObject({ status: 'warning', total: 1 });
  });
  it('mtime 超過 24h 前 1 ms → ok', async () => {
    expect(await run({ size: 3, mtime: new Date(NOW.getTime() - 24 * HOUR - 1) }, 'err')).toMatchObject({ status: 'ok', total: 0 });
  });
  it('錯誤訊息截到 100 字', async () => {
    const content = 'x'.repeat(300);
    const r = await run({ size: 300, mtime: NOW }, content);
    expect(r.details['api-server'].errors[0].message).toHaveLength(100);
  });
  it('非 ENOENT 的掃描失敗（EACCES）→ 帶 error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(r.error).toContain('api-server: denied');
    // 現況：status 仍為 ok，assess 因 data.status 優先而回 completion failed + severity ok（見 PR 內文「可疑之處」）
    expect(mk().schedulerErrors.assess(r)).toMatchObject({ completion: 'failed', severity: 'ok' });
  });
});

describe('check() 包裝的 assess', () => {
  const a = (data: Record<string, unknown>) => mk().apiErrors.assess(data);

  it('data.error 且無 status → completion failed、severity warning', () => {
    expect(a({ error: 'boom' })).toEqual({ completion: 'failed', severity: 'warning', error: 'boom' });
  });
  it('無 error 無 status → complete／ok，且不帶 error 欄位', () => {
    expect(a({})).toEqual({ completion: 'complete', severity: 'ok' });
  });
  it('data.status 優先於 error 推得的 warning', () => {
    expect(a({ status: 'critical', error: 'boom' })).toMatchObject({ severity: 'critical', completion: 'failed', error: 'boom' });
    expect(a({ status: 'ok', error: 'boom' })).toMatchObject({ severity: 'ok', completion: 'failed' });
  });
  it('data.completion 優先於 error 推得的 failed', () => {
    expect(a({ completion: 'partial', status: 'warning', error: 'e' })).toMatchObject({ completion: 'partial', severity: 'warning' });
    expect(a({ completion: 'complete', status: 'ok' })).toMatchObject({ completion: 'complete', severity: 'ok' });
  });
  it('googleMapsQuota 的 skip 路徑：status ok 帶 error → failed／ok（現況）', async () => {
    const s = mk({ getToken: async () => 't' }).googleMapsQuota;
    const r = await s.run();
    expect(r).toMatchObject({ status: 'ok' });
    expect(s.assess(r)).toMatchObject({ completion: 'failed', severity: 'ok' });
  });
});
