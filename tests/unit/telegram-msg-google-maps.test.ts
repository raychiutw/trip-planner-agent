/**
 * build-daily-check-msg.js — Google Maps free-tier headroom render (v2.46.x)
 *
 *   - status === 'critical' (≥critical% of a SKU free cap) → 🔴 + worst SKU + lock
 *   - status === 'warning' (≥80%) → 🟡 + worst SKU
 *   - status === 'warning' + error (GCP 拿不到) → 🟡 監控異常，NO fake number
 *   - status === 'ok' (<80%) → 不放 issue，metrics 區塊顯 headroom + 真實付費 $（$0）
 *   - skip (status ok + (skip) error) → 不阻斷、不示警
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BUILD_MSG = path.resolve(__dirname, '../../scripts/lib/build-daily-check-msg.js');

function runWithReport(report: Record<string, unknown>): string {
  const tmp = path.join(os.tmpdir(), `daily-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(report), 'utf8');
  try {
    const result = spawnSync('node', [BUILD_MSG, tmp], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`build-daily-check-msg failed: ${result.stderr}`);
    }
    return result.stdout;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const BASE: Record<string, unknown> = {
  date: '2026-05-19',
  generatedAt: '2026-05-19T00:00:00Z',
  summary: { totalIssues: 0, critical: 0, warning: 0, ok: 7 },
  sentry: { status: 'ok', total: 0, issues: [] },
  apiErrors: { status: 'ok', total: 0, errors: [] },
  requestErrors: { status: 'ok', total: 0, statusCounts: { open: 0, processing: 0, failed: 0 }, stuckProcessing: 0, pending: [] },
  workers: { requests: 1000, errors: 0, p50: 12, p99: 80 },
  web: { visits: 50, pageViews: 200 },
  npmAudit: { status: 'ok', total: 0, error: null },
  schedulerErrors: { status: 'ok', total: 0, details: { 'api-server': { count: 0 } } },
  routeHealth: { status: 'ok', total: 0, checked: 8, routes: [] },
  dataHygiene: { status: 'ok', total: 0, leaks: [] },
};

describe('build-daily-check-msg.js — Google Maps section', () => {
  it('renders 🔴 critical when a SKU is about to exhaust its free cap', () => {
    const report = {
      ...BASE,
      googleMapsQuota: {
        status: 'critical',
        maxPct: 95,
        worst: {
          method: 'google.maps.routing.v2.Routes.ComputeRoutes',
          usage: 9500,
          cap: 10000,
          pct: 95,
        },
        overageCost: 0,
        isLocked: true,
      },
    };
    const out = runWithReport(report);
    expect(out).toContain('🔴');
    expect(out).toContain('Google Maps');
    expect(out).toContain('ComputeRoutes'); // worst SKU short name
    expect(out).toContain('95'); // pct
    expect(out).toContain('9500'); // usage
  });

  it('renders 🟡 warning when a SKU is ≥80% of free cap', () => {
    const report = {
      ...BASE,
      googleMapsQuota: {
        status: 'warning',
        maxPct: 85,
        worst: {
          method: 'google.maps.places.v1.Places.SearchText',
          usage: 8500,
          cap: 10000,
          pct: 85,
        },
        overageCost: 0,
        isLocked: false,
      },
    };
    const out = runWithReport(report);
    expect(out).toContain('🟡');
    expect(out).toContain('SearchText');
    expect(out).toContain('85');
  });

  it('ok-state metrics line shows headroom + real $0 (transparency)', () => {
    const report = {
      ...BASE,
      googleMapsQuota: {
        status: 'ok',
        maxPct: 48.13,
        worst: {
          method: 'google.maps.routing.v2.Routes.ComputeRoutes',
          usage: 4813,
          cap: 10000,
          pct: 48.13,
        },
        overageCost: 0,
        isLocked: false,
      },
    };
    const out = runWithReport(report);
    expect(out).toContain('免費額度');
    expect(out).toContain('ComputeRoutes');
    expect(out).toContain('48');
    expect(out).toContain('$0'); // real paid cost — within free tier
  });

  it('surfaces GCP-unavailable as a visible warning and shows NO fake number', () => {
    const report = {
      ...BASE,
      googleMapsQuota: {
        status: 'warning',
        error: 'Google Cloud Monitoring 無法取得用量',
      },
    };
    const out = runWithReport(report);
    expect(out).toContain('Google Maps');
    expect(out).toMatch(/監控異常|無法取得/);
    // 不得顯示 headroom 數字行（沒資料就只報錯）
    expect(out).not.toContain('免費額度: 最高');
  });

  it('does not surface local-dev skip (status ok + skip error) as an issue', () => {
    const report = {
      ...BASE,
      googleMapsQuota: {
        status: 'ok',
        error: 'TRIPLINE_API_CLIENT_ID/SECRET missing (skip)',
      },
    };
    const out = runWithReport(report);
    expect(out).not.toContain('監控異常');
    expect(() => runWithReport(report)).not.toThrow();
  });

  it('still renders fully green when googleMapsQuota absent (back-compat)', () => {
    const out = runWithReport(BASE);
    expect(out).toContain('全綠');
  });
});
