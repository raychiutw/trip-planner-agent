/**
 * daily-check.js — Google Maps free-tier headroom section
 *
 * v2.46.x: 2025/3 起 Maps 取消 $200 月抵免，改每個 SKU 各自免費月額度。本專案
 * 用量全在免費額度內 → 真實花費 $0。監控改「每個 SKU 用掉免費額度的 %」（headroom），
 * 在跨入付費前預警。用量來自 GCP Cloud Monitoring per-method MTD counts。
 *
 * 已刪除：calcMtdCost（dailyCost × dayOfMonth 投射）、calcCost（$ MTD vs $200）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as quotaLib from '../../scripts/lib/google-maps-quota';
import {
  FREE_CAP,
  PRICE_PER_1K,
  WARN_PCT,
  calcHeadroom,
  classifyStatus,
} from '../../scripts/lib/google-maps-quota';

const DAILY_CHECK_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/daily-check.js'),
  'utf8',
);

const QUOTA_MONITOR_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/google-quota-monitor.ts'),
  'utf8',
);

const ROUTES = 'google.maps.routing.v2.Routes.ComputeRoutes';
const SEARCH = 'google.maps.places.v1.Places.SearchText';

describe('google-maps-quota helper (pure)', () => {
  describe('FREE_CAP / PRICE_PER_1K tables', () => {
    it('caps and prices cover the same 6 method SKUs', () => {
      expect(Object.keys(FREE_CAP).sort()).toEqual(Object.keys(PRICE_PER_1K).sort());
      expect(Object.keys(FREE_CAP)).toContain(ROUTES);
      expect(Object.keys(FREE_CAP)).toContain(SEARCH);
    });

    it('stays in sync with google-quota-monitor.ts SoT (drift detection)', () => {
      // Both tables are duplicated in the orphan monitor; the source must
      // contain each method key with the same cap & price value.
      for (const [method, cap] of Object.entries(FREE_CAP)) {
        expect(QUOTA_MONITOR_SRC, `cap drift: ${method}`).toContain(`'${method}': ${cap}`);
      }
      for (const [method, price] of Object.entries(PRICE_PER_1K)) {
        expect(QUOTA_MONITOR_SRC, `price drift: ${method}`).toContain(`'${method}': ${price}`);
      }
    });
  });

  describe('calcHeadroom', () => {
    it('computes per-SKU % of free cap, identifies worst, $0 overage under cap', () => {
      const h = calcHeadroom([
        { method: ROUTES, count: 4813 }, // 48.13% of 10k
        { method: SEARCH, count: 384 }, // 3.84% of 10k
      ]);
      expect(h.maxPct).toBeCloseTo(48.13, 2);
      expect(h.worst.method).toBe(ROUTES);
      expect(h.overageCostTotal).toBe(0); // all within free tier
    });

    it('prices only the overage above the free cap', () => {
      // SearchText is Enterprise tier → 1,000 free. 12,000 − 1,000 = 11,000 paid
      // × $32/1k = $352.
      const h = calcHeadroom([{ method: SEARCH, count: 12000 }]);
      expect(h.maxPct).toBeCloseTo(1200, 5);
      expect(h.overageCostTotal).toBeCloseTo(352, 5);
    });

    it('ignores unknown method (no cap) for headroom', () => {
      const h = calcHeadroom([{ method: 'billingbudgets.unknown', count: 999 }]);
      expect(h.maxPct).toBe(0);
      expect(h.worst).toBeNull();
      expect(h.overageCostTotal).toBe(0);
    });

    it('returns zero state for empty list', () => {
      const h = calcHeadroom([]);
      expect(h.maxPct).toBe(0);
      expect(h.overageCostTotal).toBe(0);
    });
  });

  describe('removed obsolete cost functions (regression lock)', () => {
    it('does NOT export calcMtdCost (projection) or calcCost ($ vs $200 budget)', () => {
      const lib = quotaLib as Record<string, unknown>;
      expect(lib.calcMtdCost).toBeUndefined();
      expect(lib.calcCost).toBeUndefined();
    });

    it('exports the headroom API only', () => {
      const names = Object.keys(quotaLib).filter((k) => k !== 'default').sort();
      expect(names).toEqual(['CRITICAL_PCT', 'FREE_CAP', 'PRICE_PER_1K', 'WARN_PCT', 'calcHeadroom', 'classifyStatus']);
    });
  });

  describe('classifyStatus (headroom % of free cap)', () => {
    it('critical when maxPct ≥ critical threshold', () => {
      expect(classifyStatus(90, 90)).toBe('critical');
      expect(classifyStatus(100, 90)).toBe('critical');
    });

    it(`warning when ${WARN_PCT}% ≤ maxPct < critical`, () => {
      expect(classifyStatus(WARN_PCT, 90)).toBe('warning');
      expect(classifyStatus(85, 90)).toBe('warning');
      expect(classifyStatus(89.99, 90)).toBe('warning');
    });

    it('ok when maxPct < warn threshold (e.g. Routes at 48%)', () => {
      expect(classifyStatus(0, 90)).toBe('ok');
      expect(classifyStatus(48.13, 90)).toBe('ok');
      expect(classifyStatus(WARN_PCT - 0.01, 90)).toBe('ok');
    });
  });
});

describe('daily-check.js — Google Maps section wiring', () => {
  it('imports lib/google-maps-quota helper', () => {
    expect(DAILY_CHECK_SRC).toMatch(/require\(['"]\.\/lib\/google-maps-quota['"]\)/);
  });

  it('defines queryGoogleMapsQuota async function', () => {
    expect(DAILY_CHECK_SRC).toMatch(/async function queryGoogleMapsQuota\(/);
  });

  it('fetches /api/admin/quota-estimate', () => {
    expect(DAILY_CHECK_SRC).toContain('/api/admin/quota-estimate');
  });

  it('computes free-tier headroom (no $ projection)', () => {
    expect(DAILY_CHECK_SRC).toMatch(/calcHeadroom\(/);
    expect(DAILY_CHECK_SRC).not.toMatch(/calcMtdCost\s*\(/);
    expect(DAILY_CHECK_SRC).not.toMatch(/calcCost\s*\(/);
  });

  it('wires googleMapsQuota into Promise.allSettled (7th source)', () => {
    expect(DAILY_CHECK_SRC).toMatch(/queryGoogleMapsQuota\(\)/);
  });


});

/*
 * 2026-07-29 —— 幽靈預算設定清除。
 *
 * Google 於 2025-03 取消 $200/月 抵免，改成各 SKU 各自的免費月額度。監控端
 * （daily-check + quota-monitor）早就改成算 free-cap headroom %，但 app_settings
 * 裡還留著 `google_maps_budget_usd = 200` 與兩個門檻 key，而
 * `/api/admin/maps-settings` 把它們原封不動回出去 —— 任何讀那支 API 的人或 agent
 * 會以為還有一筆 $200 預算在管控。
 *
 * 實測狀態（清除前）：
 *   - budget_usd            0 個決策消費者，只被 API 回出去
 *   - unlock_threshold_pct  0 個消費者（它要驅動的「daily-check 自動解鎖」從未實作）
 *   - lock_threshold_pct    有消費者，但兩端都已 `|| 90` fallback → 改寫死在 lib
 *
 * owner 決定三個全清、門檻寫死。以下守住「不會被悄悄加回來」。
 */
/** 剝掉 // 與 /* *\/ 註解 —— 守衛要驗的是**程式碼**，不是解釋為什麼移除的散文。
 *  （不剝的話，這支測試會被它自己在 maps-settings.ts 寫的「別把 budget_usd 加回來」
 *  註解絆倒 —— 實測踩過。） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('幽靈預算設定不得復活', () => {
  const QUOTA_MONITOR_CODE = stripComments(QUOTA_MONITOR_SRC);
  const DAILY_CHECK_CODE = stripComments(DAILY_CHECK_SRC);

  // 跨專案的守衛（web 的 maps-settings／_app_settings 不再提及三個幽靈 key、仍回傳鎖定狀態）原本在這裡，
  // 讀的是 web repo 的檔案；agent repo 看不到，已不在這裡驗證（見 PR 內文「沒搬的跨專案測試」）。
  // 以下只守 agent 這一側：門檻寫死在 lib、兩支 script 不再向 API 要門檻。

  it('CRITICAL_PCT 常數存在且 lib 與 quota-monitor 同步（比照 WARN_PCT 的 drift 守法）', () => {
    expect(quotaLib.CRITICAL_PCT).toBe(90);
    expect(QUOTA_MONITOR_SRC).toContain('CRITICAL_PCT = 90');
  });

  it('兩支 script 不再從 API 拿門檻', () => {
    expect(DAILY_CHECK_CODE).not.toContain('lock_threshold_pct');
    expect(QUOTA_MONITOR_CODE).not.toContain('lock_threshold_pct');
  });

  it('quota-monitor 不再為了門檻多打一次 maps-settings', () => {
    expect(QUOTA_MONITOR_CODE).not.toContain('/api/admin/maps-settings');
  });
});
