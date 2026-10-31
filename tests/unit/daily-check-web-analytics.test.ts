import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCheckSources } = require('../../scripts/daily-check.js');
const { createReportSources } = require('../../scripts/daily-report.js');

const fetch = async (_url: string, options: { body: string }) => {
  const { query } = JSON.parse(options.body);
  if (!query.includes('count sum { visits }')) {
    return { ok: true, json: async () => ({ errors: [{ message: 'unknown field "pageViews"' }], data: null }) };
  }
  return {
    ok: true,
    json: async () => ({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count: 166, sum: { visits: 17 } }] }] } } }),
  };
};

it('Web Analytics 使用 pageload count 作為 pageViews', async () => {
  const result = await createCheckSources({ fetch, env: { CF_ACCOUNT_ID: 'test' } }).web.run();
  expect(result).toEqual({ visits: 17, pageViews: 166 });
});

it('排程寄送的日報使用相同的 Web Analytics 計數', async () => {
  const result = await createReportSources({ fetch }).web.run();
  expect(result).toMatchObject({ visits: 17, pageViews: 166 });
});
