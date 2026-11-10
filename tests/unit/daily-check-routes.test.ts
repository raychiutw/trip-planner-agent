import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(__dirname, '../..');
const web = JSON.parse(readFileSync(join(root, 'tests/fixtures/web-routes.json'), 'utf8')) as {
  pages: string[];
  legacyRedirects: string[];
};
const src = readFileSync(join(root, 'scripts/daily-check.js'), 'utf8');
const body = /var ROUTES = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
const routes = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);

const toRegex = (p: string) => new RegExp('^' + p.replace(/:[^/]+/g, '[^/]+') + '$');

it('抓得到 ROUTES 清單', () => {
  expect(routes.length).toBeGreaterThan(0);
});

it('ROUTES 每個路徑都對應 web 的實際頁面路由（SPA 對任何路徑都回 200，舊路徑檢查無意義）', () => {
  const unmatched = routes.filter((r) => !web.pages.some((p) => toRegex(p).test(r)));
  expect(unmatched).toEqual([]);
});

it('ROUTES 不含只剩 Navigate 轉址的舊路徑', () => {
  expect(routes.filter((r) => web.legacyRedirects.includes(r))).toEqual([]);
});
