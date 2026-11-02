import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function linkIo(failedDays = false) {
  return {
    getToken: async () => 'test-token',
    fetch: vi.fn(async (url: string, _options?: RequestInit) => {
      if (url.endsWith('/api/trips')) return Response.json([{ id: 'good', published: true }, { id: 'bad', published: true }]);
      if (url.endsWith('/good/days')) return Response.json([{ timeline: [{ location: { googleQuery: 'https://maps.google.com/good' } }] }]);
      if (url.endsWith('/bad/days')) return failedDays ? new Response('', { status: 503 }) : Response.json([]);
      if (url === 'https://maps.google.com/good') return new Response('', { status: 200 });
      throw new Error('Unexpected external request: ' + url);
    }),
  };
}

describe('one operations run through real sources and report rendering', () => {
  it('preserves successful link evidence when another trip cannot be checked', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createReportSources, buildHtml } = require('../../scripts/daily-report');
    const result = await runOperations({ links: createReportSources(linkIo(true)).links }, { now: () => new Date('2026-09-21T00:00:00Z') });
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized.sources.links.completion).toBe('partial');
    expect(serialized.sources.links.data.checked).toBe(1);
    expect(serialized.sources.links.data.failures).toEqual([expect.objectContaining({ tripId: 'bad' })]);
    expect(serialized.summary.healthy).toBe(false);
    const html = buildHtml(result);
    expect(html).toContain('部分完成');
    expect(html).not.toContain('全部連結正常');
  });
  it.each([
    ['complete', 'complete', false, true],
    ['zero', 'complete', true, false],
    ['all-days-fail', 'failed', false, false],
    ['partial-broken', 'partial', false, false],
    ['timeout', 'partial', false, false],
    ['empty-days', 'complete', true, false],
    ['token-fail', 'failed', false, false],
  ])('%s remains distinct in JSON, HTML and summary', async (scenario, completion, empty, healthy) => {
    const { runOperations, summaryText } = require('../../scripts/lib/operations-run');
    const { createReportSources, buildHtml } = require('../../scripts/daily-report');
    const io = linkIo();
    const fetch = io.fetch;
    io.fetch = vi.fn(async (url: string) => {
      if (scenario === 'zero' && url.endsWith('/api/trips')) return Response.json([]);
      if (scenario === 'all-days-fail' && url.endsWith('/days')) return new Response('', { status: 503 });
      if (scenario === 'empty-days' && url.endsWith('/days')) return Response.json([]);
      if (scenario === 'timeout' && url.endsWith('/bad/days')) throw new DOMException('Timed out', 'TimeoutError');
      if (scenario === 'partial-broken') {
        if (url.endsWith('/bad/days')) return new Response('', { status: 503 });
        if (url === 'https://maps.google.com/good') return new Response('', { status: 404 });
      }
      return fetch(url);
    });
    if (scenario === 'token-fail') io.getToken = async () => { throw new Error('Token unavailable'); };
    const result = await runOperations({ links: createReportSources(io).links });
    const html = buildHtml(result);
    const json = JSON.parse(JSON.stringify(result));
    expect(json.sources.links.completion).toBe(completion);
    expect(json.summary).toMatchObject({ completion, empty, healthy });
    expect(html).toContain(summaryText(result.summary));
    if (healthy) expect(html).toContain('全部連結正常');
    else expect(html).not.toContain('全部連結正常');
    if (scenario === 'partial-broken') {
      expect(json.sources.links.data.broken).toEqual([{ url: 'https://maps.google.com/good', status: 404 }]);
      expect(json.summary.severity).toBe('critical');
      expect(html).toContain('1 個壞連結');
      expect(html).toContain('部分完成');
    }
    if (scenario === 'token-fail') expect(io.fetch).not.toHaveBeenCalled();
  });

  it('link transport failure retains its existing broken-link severity and marks the check incomplete', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createReportSources, buildHtml } = require('../../scripts/daily-report');
    const io = linkIo();
    const fetch = io.fetch;
    io.fetch = vi.fn(async (url: string) => {
      if (url === 'https://maps.google.com/good') throw new DOMException('Timed out', 'TimeoutError');
      return fetch(url);
    });
    const result = await runOperations({ links: createReportSources(io).links });
    expect(result.sources.links).toMatchObject({ completion: 'partial', severity: 'critical' });
    const html = buildHtml(result);
    expect(html).toContain('network error');
    expect(html).toContain('部分完成');
  });

});

function checkIo(routeMode = 'healthy') {
  return {
    env: { TRIPLINE_API_CLIENT_ID: 'test-client', TRIPLINE_API_CLIENT_SECRET: 'test-secret' },
    now: () => new Date('2026-09-21T00:00:00Z'),
    getToken: async () => 'test-token',
    queryD1: vi.fn(async () => []),
    execSync: vi.fn(() => JSON.stringify({ vulnerabilities: {} })),
    fs: { statSync: () => { throw Object.assign(new Error('No logs'), { code: 'ENOENT' }); } },
    fetch: vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes('sentry.io')) return Response.json([]);
      if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [], rumPageloadEventsAdaptiveGroups: [] }] } } });
      if (url.endsWith('/maps-settings')) return Response.json({ is_locked: false });
      if (url.endsWith('/quota-estimate')) return Response.json([]);
      if (options?.redirect === 'manual') {
        if (routeMode === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        return new Response('', { status: routeMode === 'unhealthy' ? 503 : 200 });
      }
      throw new Error('Unexpected external request: ' + url);
    }),
  };
}

describe('all daily-check sources share one outcome', () => {
  it('route health failures appear in the same JSON, HTML and message summary', async () => {
    const { runOperations, renderOperationsHtml, summaryText } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
    const result = await runOperations(createCheckSources(checkIo('unhealthy')));
    expect(result.sources.routeHealth).toMatchObject({ completion: 'complete', severity: 'critical' });
    expect(result.summary).toMatchObject({ completion: 'complete', severity: 'critical', healthy: false });
    const html = renderOperationsHtml(result);
    const message = buildDailyCheckMessage({ ...result, date: '2026-09-21' });
    expect(html).toContain(summaryText(result.summary));
    expect(message).toContain(summaryText(result.summary));
    expect(message).toContain('routeHealth');
    expect(message).not.toContain('全綠');
  });
});

it('daily-report keeps successful anomaly findings when a later required query fails', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createReportSources, buildHtml } = require('../../scripts/daily-report');
  const io = {
    ...linkIo(),
    queryD1: async (sql: string) => {
      if (sql.includes('td.id IS NULL')) return [{ id: 'empty-trip' }];
      throw new Error('D1 query unavailable');
    },
  };
  const sources = createReportSources(io);
  expect(sources.anomalies).toBeDefined();
  const result = await runOperations({ links: sources.links, anomalies: sources.anomalies });
  expect(result.sources.anomalies).toMatchObject({ completion: 'partial', severity: 'warning' });
  expect(result.sources.anomalies.data.items.join(' ')).toContain('empty-trip');
  expect(result.summary).toMatchObject({ completion: 'partial', healthy: false, severity: 'warning' });
  const html = buildHtml(result);
  expect(html).toContain('empty-trip');
  expect(html).toContain('部分完成');
});

describe('complete operations evidence and existing source policies', () => {
  it('all daily-check sources run, zero issues are healthy, and informational metrics stay informational', async () => {
    const { runOperations, renderOperationsHtml } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const io = checkIo();
    const result = await runOperations(createCheckSources(io), { now: io.now });
    expect(Object.keys(result.sources).sort()).toEqual(['sentry', 'apiErrors', 'workers', 'web', 'requestErrors', 'routeHealth', 'dataHygiene', 'googleMapsQuota', 'auditAnomaly', 'npmAudit', 'schedulerErrors'].sort());
    expect(result.summary).toMatchObject({ completion: 'complete', healthy: true, critical: 0, warning: 0 });
    expect(result.generatedAt).toBe('2026-09-21T00:00:00.000Z');
    expect(result.sources.workers).toMatchObject({ required: false, informational: true });
    expect(renderOperationsHtml(result)).toContain('全部健康');
    expect(io.execSync).toHaveBeenCalledWith(expect.stringContaining('npm audit'), expect.objectContaining({ timeout: 180000, maxBuffer: 32 * 1024 * 1024 }));
    expect(io.fetch.mock.calls.every(([url]) => !url.includes('telegram') && !url.includes('resend'))).toBe(true);
  });

  it('route timeout and a confirmed API anomaly both survive the same partial result', async () => {
    const { runOperations, renderOperationsHtml } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
    const io = checkIo('timeout');
    io.queryD1 = vi.fn(async (sql: string) => sql.includes('FROM api_logs') ? [{ path: '/api/test', status: 500, count: 7 }] : []);
    const result = await runOperations(createCheckSources(io));
    expect(result.sources.routeHealth.completion).toBe('failed');
    expect(result.sources.apiErrors.data.total).toBe(7);
    expect(result.summary).toMatchObject({ completion: 'partial', severity: 'critical', healthy: false });
    const html = renderOperationsHtml(result);
    const msg = buildDailyCheckMessage({ ...result, date: '2026-09-21' });
    expect(html).toContain('/api/test');
    expect(msg).toContain('routeHealth');
    expect(msg).toContain('apiErrors');
    expect(msg).toContain('部分完成');
  });

  it('failure of every required source is failed, with no fictitious zero-issue success', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const io = checkIo();
    io.fetch = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    io.queryD1 = vi.fn(async () => { throw new Error('D1 unavailable'); });
    io.execSync = vi.fn(() => { throw new Error('audit timeout'); });
    io.fs.statSync = () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); };
    const result = await runOperations(createCheckSources(io));
    expect(result.summary).toMatchObject({ completion: 'failed', healthy: false });
    for (const source of Object.values(result.sources) as any[]) expect(source.completion).toBe('failed');
  });

  it('unavailable information sources retain an error without becoming health alerts', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const io = checkIo();
    const fetch = io.fetch;
    io.fetch = vi.fn(async (url: string, options?: RequestInit) => url.endsWith('/graphql')
      ? Response.json({ errors: [{ message: 'Unavailable' }] }) : fetch(url, options));
    const result = await runOperations(createCheckSources(io));
    expect(result.sources.workers).toMatchObject({ completion: 'failed', informational: true, data: null });
    expect(result.sources.web.completion).toBe('failed');
    expect(result.summary).toMatchObject({ completion: 'complete', healthy: true, critical: 0, warning: 0 });
  });

  it.each(['', '{"error":{"code":"EAUDIT"}}'])('an absent audit result is incomplete, not zero vulnerabilities: %s', async (output) => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const io = checkIo();
    io.execSync = vi.fn(() => output);
    const result = await runOperations(createCheckSources(io));
    expect(result.sources.npmAudit).toMatchObject({ completion: 'failed', severity: 'critical' });
    expect(result.summary.healthy).toBe(false);
  });

  it('below-threshold API counts do not become alerts in the message renderer', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
    const io = checkIo();
    io.queryD1 = vi.fn(async (sql: string) => sql.includes('FROM api_logs') ? [{ path: '/api/test', status: 404, count: 1 }] : []);
    const result = await runOperations(createCheckSources(io));
    expect(result.sources.apiErrors.data.total).toBe(1);
    expect(result.summary).toMatchObject({ healthy: true, totalIssues: 0 });
    expect(buildDailyCheckMessage({ ...result, date: '2026-09-21' })).not.toContain('apiErrors：');
  });

  it('audit anomalies use the real query adapter and reach the common summary', async () => {
    const { runOperations } = require('../../scripts/lib/operations-run');
    const { createCheckSources } = require('../../scripts/daily-check');
    const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
    const io = checkIo();
    io.queryD1 = vi.fn(async (sql: string) => sql.includes('AS deletes') ? [{ tableName: 'trips', deletes: 11 }] : []);
    const result = await runOperations(createCheckSources(io));
    expect(result.sources.auditAnomaly).toMatchObject({ completion: 'complete', severity: 'critical', data: { criticalDeletes: [{ tableName: 'trips', deletes: 11 }] } });
    expect(buildDailyCheckMessage({ ...result, date: '2026-09-21' })).toContain('auditAnomaly');
  });

  it('the complete daily-report uses all existing sources and preserves raw metrics as information', async () => {
    const { runOperations, summaryText } = require('../../scripts/lib/operations-run');
    const { createReportSources, buildHtml } = require('../../scripts/daily-report');
    const links = linkIo();
    const io = {
      ...links,
      now: () => new Date('2026-09-21T00:00:00Z'),
      queryD1: async (sql: string) => sql.includes('COUNT(*) as total') ? [{ total: 0, open_count: 0, closed_count: 0 }]
        : sql.includes('count_4xx') ? [{ count_4xx: 20, count_5xx: 3 }] : [],
      fetch: async (url: string, options?: RequestInit) => {
        if (url.includes('sentry.io')) return Response.json([]);
        if (url.endsWith('/graphql')) return Response.json({ data: { viewer: { accounts: [{ pagesFunctionsInvocationsAdaptiveGroups: [], rumPageloadEventsAdaptiveGroups: [] }] } } });
        if (url.includes('pagespeedonline')) return Response.json({ lighthouseResult: { categories: Object.fromEntries(['performance','seo','accessibility','best-practices'].map((name) => [name, { score: 0.8 }])) } });
        return links.fetch(url);
      },
    };
    const result = await runOperations(createReportSources(io), { now: io.now });
    expect(Object.keys(result.sources).sort()).toEqual(['links','requests','workers','web','lighthouse','sentry','apiLogs','anomalies'].sort());
    expect(result.summary).toMatchObject({ healthy: true, completion: 'complete' });
    expect(result.sources.apiLogs).toMatchObject({ informational: true, data: { summary: { count_5xx: 3 } } });
    const html = buildHtml(result);
    expect(html).toContain(summaryText(result.summary));
    expect(html).toContain('2026-09-21');
    expect(html).toContain('全部連結正常');
  });
});

it('Google Maps alert severity reaches the real run and message using the existing quota calculation', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createCheckSources } = require('../../scripts/daily-check');
  const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
  const { FREE_CAP } = require('../../scripts/lib/google-maps-quota');
  const method = 'google.maps.routing.v2.Routes.ComputeRoutes';
  const io = checkIo();
  const fetch = io.fetch;
  io.fetch = vi.fn(async (url: string, options?: RequestInit) => url.endsWith('/quota-estimate')
    ? Response.json([{ method, count: FREE_CAP[method] }]) : fetch(url, options));
  const result = await runOperations(createCheckSources(io));
  expect(result.sources.googleMapsQuota).toMatchObject({ completion: 'complete', severity: 'critical', data: { maxPct: 100 } });
  expect(result.summary).toMatchObject({ healthy: false, critical: 1 });
  expect(buildDailyCheckMessage({ ...result, date: '2026-09-21' })).toContain('googleMapsQuota');
});

it('pending request evidence flows through the actual query and mapping without the retired mode column', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createCheckSources } = require('../../scripts/daily-check');
  const io = checkIo();
  io.queryD1 = vi.fn(async (sql: string) => {
    if (!sql.includes('FROM trip_requests')) return [];
    expect(sql).not.toMatch(/\bmode\b/);
    return [{ id: 'pending-1', trip_id: 'trip-1', status: 'failed', message: 'failure evidence', created_at: '2026-09-20T23:59:00Z' }];
  });
  const result = await runOperations(createCheckSources(io));
  expect(result.sources.requestErrors).toMatchObject({ completion: 'complete', severity: 'warning' });
  expect(result.sources.requestErrors.data.pending[0]).toMatchObject({ id: 'pending-1', message: 'failure evidence' });
  expect(result.sources.requestErrors.data.pending[0]).not.toHaveProperty('mode');
});

it('message output does not fabricate zero Workers metrics after a query failure', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createCheckSources } = require('../../scripts/daily-check');
  const { buildDailyCheckMessage } = require('../../scripts/lib/build-daily-check-msg');
  const io = checkIo();
  const fetch = io.fetch;
  io.fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/graphql')) throw new Error('Metrics unavailable');
    return fetch(url, options);
  });
  const result = await runOperations(createCheckSources(io));
  const message = buildDailyCheckMessage({ ...result, date: '2026-09-21', workers: { error: 'Metrics unavailable' } });
  expect(message).not.toContain('Workers: 0 req');
  expect(message).toContain('workers：未完成');
});

it('link collection waits for its token and authenticates trip and day requests', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createReportSources } = require('../../scripts/daily-report');
  const io = linkIo();
  let resolveToken!: (token: string) => void;
  io.getToken = () => new Promise<string>((resolve) => { resolveToken = resolve; });
  const pending = runOperations({ links: createReportSources(io).links });
  expect(io.fetch).not.toHaveBeenCalled();
  resolveToken('controlled-token');
  const result = await pending;
  expect(result.summary.healthy).toBe(true);
  for (const [url, options] of io.fetch.mock.calls) {
    if (url.includes('/api/trips')) expect(options?.headers).toEqual({ Authorization: 'Bearer controlled-token' });
  }
});

it('default daily-check configuration comes from process environment', async () => {
  const { runOperations } = require('../../scripts/lib/operations-run');
  const { createCheckSources } = require('../../scripts/daily-check');
  const io = checkIo();
  vi.stubEnv('SENTRY_ORG', 'controlled-org');
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'controlled-token');
  try {
    await runOperations(createCheckSources({ ...io, env: undefined }));
    expect(io.fetch).toHaveBeenCalledWith(expect.stringContaining('/projects/controlled-org/'), expect.objectContaining({ headers: { Authorization: 'Bearer controlled-token' } }));
  } finally { vi.unstubAllEnvs(); }
});
