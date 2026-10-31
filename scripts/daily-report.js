#!/usr/bin/env node
/**
 * daily-report.js — 每日健康報告腳本
 *
 * 彙整 7 個數據來源，組合 HTML email，透過 Resend API 寄出。
 * 由 GitHub Actions 每天 UTC 22:23（台灣 06:23）自動觸發。
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID
 *   SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
 *   SITE_URL
 */
'use strict';
var { runOperations, summaryText, sourceText } = require('./lib/operations-run');

var CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
var CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
var D1_DB = process.env.D1_DATABASE_ID;
var SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
var SENTRY_ORG = process.env.SENTRY_ORG;
var SENTRY_PROJECT = process.env.SENTRY_PROJECT;
var fs = require('fs');
var path = require('path');
var REPORT_EMAIL = process.env.REPORT_EMAIL;
var SITE_URL = process.env.SITE_URL || 'https://trip-planner-dby.pages.dev';
var PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';

// ── D1 REST API helper ──────────────────────────────────────────
// v2.33.29: 移到 scripts/lib/d1-client.js
var { queryD1 } = require('./lib/d1-client');
// v2.33.50 round 8b: mint OAuth token for authenticated /api/trips fetch
// (post v2.33.41 anonymous-read fix，unpublished trip GET 需 auth)。
var { getToken: getTriplineToken } = require('./lib/get-tripline-token');
var { sendTelegram } = require('./lib/telegram');

// ── 數據來源 1: 行程修改統計 ────────────────────────────────────

function createReportSources(io = {}) {
  var fetch = io.fetch || globalThis.fetch;
  var queryD1 = io.queryD1 || require('./lib/d1-client').queryD1;
  var now = io.now || (() => new Date());
  var todayISO = () => now().toISOString().slice(0, 10);
  var yesterdayISO = () => new Date(now().getTime() - 86400000).toISOString().slice(0, 10);

  async function queryD1Requests() {
    var rows = await queryD1(
      "SELECT " +
      "COUNT(*) as total, " +
      "SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open_count, " +
      "SUM(CASE WHEN status IN ('received','processing','completed') THEN 1 ELSE 0 END) as closed_count " +
      "FROM trip_requests WHERE created_at >= datetime('now', '-1 day')"
    );
    return rows[0];
  }

  // ── 數據來源 2: 後端 API 錯誤 ──────────────────────────────────

  async function queryD1ApiLogs() {
    var countRows = await queryD1(
      "SELECT " +
      "SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) as count_4xx, " +
      "SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) as count_5xx " +
      "FROM api_logs WHERE created_at >= datetime('now', '-1 day')"
    );
    var topRows = await queryD1(
      "SELECT path, status, COUNT(*) as cnt " +
      "FROM api_logs WHERE created_at >= datetime('now', '-1 day') AND status >= 400 " +
      "GROUP BY path, status ORDER BY cnt DESC LIMIT 5"
    );
    return { summary: countRows[0], topErrors: topRows };
  }



  // ── 數據來源 4: Sentry 前端錯誤 ────────────────────────────────

  async function querySentry() {
    var url = 'https://sentry.io/api/0/projects/' + SENTRY_ORG + '/' + SENTRY_PROJECT +
      '/issues/?query=is:unresolved&statsPeriod=24h';
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + SENTRY_TOKEN }
    });
    if (!res.ok) throw new Error('Sentry API failed: ' + res.status);
    var issues = await res.json();
    return {
      total: issues.length,
      top3: issues.slice(0, 3).map(function(i) {
        return { title: i.title, count: i.count, link: i.permalink };
      })
    };
  }

  // ── 數據來源 5: Workers Analytics ──────────────────────────────

  async function queryWorkersAnalytics() {
    var query = '{ viewer { accounts(filter: {accountTag: "' + CF_ACCOUNT + '"}) { ' +
      'pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { ' +
      'datetime_geq: "' + yesterdayISO() + 'T00:00:00Z", ' +
      'datetime_lt: "' + todayISO() + 'T00:00:00Z" }) { ' +
      'sum { requests errors subrequests } ' +
      'quantiles { cpuTimeP50 cpuTimeP99 } ' +
      'dimensions { scriptName } ' +
      '} } } }';
    var res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: query })
    });
    if (!res.ok) throw new Error('CF GraphQL failed: ' + res.status);
    var data = await res.json();
    if (data.errors?.length || !data.data || !data.data.viewer || !data.data.viewer.accounts || !data.data.viewer.accounts[0]) {
      throw new Error('Workers Analytics response unavailable');
    }
    var rows = data.data.viewer.accounts[0].pagesFunctionsInvocationsAdaptiveGroups;
    if (!rows || rows.length === 0) return { requests: 0, errors: 0, p50: 0, p99: 0 };
    var totalRequests = 0;
    var totalErrors = 0;
    var maxP50 = 0;
    var maxP99 = 0;
    rows.forEach(function(row) {
      totalRequests += row.sum.requests;
      totalErrors += row.sum.errors;
      if (row.quantiles.cpuTimeP50 > maxP50) maxP50 = row.quantiles.cpuTimeP50;
      if (row.quantiles.cpuTimeP99 > maxP99) maxP99 = row.quantiles.cpuTimeP99;
    });
    return {
      requests: totalRequests,
      errors: totalErrors,
      p50: maxP50,
      p99: maxP99
    };
  }

  // ── 數據來源 6: Web Analytics（GraphQL rumPageloadEventsAdaptiveGroups）──

  async function queryWebAnalytics() {
    var query = '{ viewer { accounts(filter: {accountTag: "' + CF_ACCOUNT + '"}) { ' +
      'rumPageloadEventsAdaptiveGroups(limit: 1, filter: { ' +
      'datetime_geq: "' + yesterdayISO() + 'T00:00:00Z", ' +
      'datetime_lt: "' + todayISO() + 'T00:00:00Z" }) { ' +
      'count sum { visits } ' +
      '} } } }';
    var res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: query })
    });
    if (!res.ok) throw new Error('CF GraphQL failed: ' + res.status);
    var data = await res.json();
    if (data.errors?.length || !data.data || !data.data.viewer || !data.data.viewer.accounts || !data.data.viewer.accounts[0]) {
      throw new Error('Web Analytics response unavailable');
    }
    var rows = data.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups;
    if (!rows || rows.length === 0) {
      return { visits: 0, pageViews: 0, lcp: '—', cls: '—', inp: '—' };
    }
    var row = rows[0];
    // Core Web Vitals 在 rumWebVitalsEventsAdaptiveGroups，這裡先用 pageload 的 visits/pageViews
    return {
      visits: row.sum?.visits || 0,
      pageViews: row.count || 0,
      lcp: '—',
      cls: '—',
      inp: '—'
    };
  }

  // ── 數據來源 7: Lighthouse (PageSpeed Insights API) ────────────

  async function runLighthouse() {
    var apiUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
      '?url=' + encodeURIComponent(SITE_URL) +
      '&category=performance&category=seo&category=accessibility&category=best-practices' +
      (PAGESPEED_API_KEY ? '&key=' + PAGESPEED_API_KEY : '');
    var res = await fetch(apiUrl);
    if (!res.ok) throw new Error('PageSpeed Insights failed: ' + res.status);
    var data = await res.json();
    var cats = data.lighthouseResult.categories;
    return {
      performance: Math.round(cats.performance.score * 100),
      seo: Math.round(cats.seo.score * 100),
      accessibility: Math.round(cats.accessibility.score * 100),
      bestPractices: Math.round(cats['best-practices'].score * 100)
    };
  }

  // ── 壞連結檢查 ─────────────────────────────────────────────────

  async function checkLinks(io = {}) {
    var fetch = io.fetch || globalThis.fetch;
    var getToken = io.getToken || getTriplineToken;

    // Authentication failure means the check did not run; runOperations records it.
    var token = await getToken();
    var authHeaders = { Authorization: 'Bearer ' + token };

    // 1. 取得所有行程
    var tripsRes = await fetch(SITE_URL + '/api/trips', { headers: authHeaders });
    if (!tripsRes.ok) throw new Error('Failed to fetch trips: ' + tripsRes.status);
    var trips = await tripsRes.json();

    // 2. 收集所有 maps URLs
    // v2.33.91 simplify: 平行 fetch /days per trip。之前 sequential await loop
    // 20 個 published trip = 20 個 round-trip 串接（~20s），改 Promise.all (~1s)。
    var mapsUrls = [];
    var publishedTripIds = trips
      .filter(function (t) { return t.published && (t.id || t.tripId); })
      .map(function (t) { return t.id || t.tripId; });
    var failures = [];
    var completedTrips = 0;
    var daysResults = await Promise.allSettled(publishedTripIds.map(async function (id) {
      var response = await fetch(SITE_URL + '/api/trips/' + id + '/days', { headers: authHeaders });
      if (!response.ok) throw new Error('Days query failed: ' + response.status);
      var days = await response.json();
      if (!Array.isArray(days)) throw new Error('Invalid days response');
      return days;
    }));
    daysResults.forEach(function(result, index) {
      if (result.status === 'fulfilled') {
        completedTrips++;
        collectMapsUrls(result.value, mapsUrls);
      } else {
        failures.push({ tripId: publishedTripIds[index], error: String(result.reason?.message || result.reason) });
      }
    });

    // 3. HEAD check with concurrency limit of 5
    // v2.33.52 cleanup (round 8d defer): host allowlist 防 SSRF — trip 的 maps
    // URL 來自 user-submitted chat / POI，如果有 attacker 注入 internal host
    // (e.g. http://192.168.x.x:port) → HEAD with redirect:follow 可達內網。
    var ALLOWED_HOSTS = new Set([
      'maps.google.com',
      'www.google.com',
      'goo.gl',
      'maps.app.goo.gl',
      'maps.apple.com',
      'apple.co',
      'map.naver.com',
      'naver.me',
    ]);
    function isAllowedUrl(u) {
      try {
        var parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        return ALLOWED_HOSTS.has(parsed.hostname);
      } catch (_) {
        return false;
      }
    }

    var broken = [];
    var urls = dedup(mapsUrls).filter(isAllowedUrl);
    var batches = chunk(urls, 5);

    for (var b = 0; b < batches.length; b++) {
      var results = await Promise.allSettled(
        batches[b].map(function(url) {
          return fetch(url, { method: 'HEAD', redirect: 'follow' })
            .then(function(r) {
              if (r.status >= 400) broken.push({ url: url, status: r.status });
            });
        })
      );
      // Also catch network errors
      results.forEach(function(r, idx) {
        if (r.status === 'rejected') {
          broken.push({ url: batches[b][idx], status: 'network error' });
          failures.push({ url: batches[b][idx], error: String(r.reason?.message || r.reason) });
        }
      });
    }

    return { broken: broken, checked: urls.length, tripCount: publishedTripIds.length, completedTrips: completedTrips, failures: failures };
  }

  function createLinkSources(io = {}) {
    return {
      links: {
        run: () => checkLinks(io),
        assess: (data) => ({
          completion: data.failures.length === 0 ? 'complete'
            : data.completedTrips + data.checked > data.failures.filter((failure) => failure.url).length ? 'partial' : 'failed',
          severity: data.broken.length ? 'critical' : 'ok',
          empty: data.checked === 0,
        }),
      },
    };
  }

  function collectMapsUrls(days, out) {
    if (!Array.isArray(days)) return;
    days.forEach(function(day) {
      if (!day.timeline) return;
      day.timeline.forEach(function(entry) {
        if (entry.location) {
          if (entry.location.googleQuery) out.push(entry.location.googleQuery);
          if (entry.location.appleQuery) out.push(entry.location.appleQuery);
          if (entry.location.naverQuery) out.push(entry.location.naverQuery);
        }
      });
    });
  }

  function dedup(arr) {
    return arr.filter(function(v, i, a) { return a.indexOf(v) === i; });
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }

  // ── 資料異常偵測 ───────────────────────────────────────────────

  async function checkDataAnomalies() {
    var anomalies = [];
    var failures = [];
    var completed = 0;
    async function query(name, sql) {
      try { var rows = await queryD1(sql); completed++; return rows; }
      catch (error) { failures.push({ query: name, error: String(error.message || error) }); return []; }
    }
    try {
      // 1. 空行程（有 trip 但 0 天）
      var emptyTrips = await query('emptyTrips',
        "SELECT t.id FROM trips t LEFT JOIN trip_days td ON t.id = td.trip_id WHERE td.id IS NULL AND t.published = 1"
      );
      if (emptyTrips && emptyTrips.length > 0) {
        anomalies.push('空行程（無天數）：' + emptyTrips.map(function(r) { return r.id; }).join(', '));
      }

      // 2. 孤立 POI（trip_entry_pois 引用不存在的 poi_id；v2.29.0 trip_pois rip-out 後 canonical 改用 trip_entry_pois）
      var orphanPois = await query('orphanPois',
        "SELECT tep.entry_id, tep.poi_id FROM trip_entry_pois tep LEFT JOIN pois p ON tep.poi_id = p.id WHERE p.id IS NULL LIMIT 10"
      );
      if (orphanPois && orphanPois.length > 0) {
        anomalies.push('孤立 trip_entry_pois（poi 不存在）：' + orphanPois.length + ' 筆');
      }

      // 3. 使用者錯誤回報（過去 24 小時）
      var recentReports = await query('recentReports',
        "SELECT COUNT(*) as c FROM error_reports WHERE created_at > datetime('now', '-1 day')"
      );
      if (recentReports && recentReports[0] && recentReports[0].c > 0) {
        anomalies.push('使用者錯誤回報（24h）：' + recentReports[0].c + ' 筆');
      }

      // 4. POI 缺 rating 比例（migration 0045: pois.google_rating renamed to rating）
      var poiStats = await query('poiStats',
        "SELECT COUNT(*) as total, SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END) as missing FROM pois WHERE type IN ('hotel','restaurant','shopping')"
      );
      if (poiStats && poiStats[0] && poiStats[0].total > 0) {
        var pct = Math.round(poiStats[0].missing / poiStats[0].total * 100);
        if (pct > 30) {
          anomalies.push('POI 缺 rating：' + poiStats[0].missing + '/' + poiStats[0].total + ' (' + pct + '%)');
        }
      }
    } catch (e) {
      failures.push({ query: 'response', error: e.message });
    }
    return { items: anomalies, failures: failures, completed: completed };
  }

  const information = (run) => ({ run, required: false, informational: true });
  return {
    ...createLinkSources(io),
    requests: information(queryD1Requests),
    workers: information(queryWorkersAnalytics),
    web: information(queryWebAnalytics),
    lighthouse: information(runLighthouse),
    sentry: { run: querySentry, assess: (data) => ({ severity: data.total ? 'warning' : 'ok' }) },
    // This report is a raw API error count (unlike daily-check's filtered alerts).
    apiLogs: information(queryD1ApiLogs),
    anomalies: { run: checkDataAnomalies, assess: (data) => ({
      completion: !data.failures.length ? 'complete' : data.completed ? 'partial' : 'failed',
      severity: data.items.length || data.failures.length ? 'warning' : 'ok',
    }) },
  };
}

// ── 清理舊 api_logs ────────────────────────────────────────────
// v2.33.61 round 14b: api_logs retention 挪到 scripts/auth-cleanup.js (60d) —
// daily-report.js 跑在 mac mini，offline > 30d 風險。auth-cleanup 走 CF Pages
// cron 較可靠。本 function 留空殼避免 caller 改錯 (auth-cleanup 接手後即可拔)。
async function cleanupOldLogs() {
  // No-op — see scripts/auth-cleanup.js step 9。
}

// ── Telegram 通知 ──────────────────────────────────────────────

async function sendTelegramAlert(anomalies) {
  var text = '⚠️ Tripline 資料異常\n\n' + anomalies.join('\n');
  var r = await sendTelegram(text, { parseMode: 'HTML' });
  if (r.ok) console.log('Telegram alert sent');
  else if (r.reason === 'not-configured') console.log('Telegram not configured, skipping alert');
  else console.error('Telegram alert failed:', r.reason);
}

// ── 日期工具 ────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayISO() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatDate() {
  var d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// ── HTML 郵件組裝 ──────────────────────────────────────────────

function buildHtml(results) {
  var sections = [sectionHtml('檢查摘要', escHtml(summaryText(results.summary)))];
  function sourceSection(name, title, renderer) {
    const source = results.sources[name];
    if (!source) return;
    sections.push(sectionHtml(title, '<p>' + escHtml(sourceText(name, source)) + '</p>' + (source.empty && source.data == null ? '<p>零資料</p>' : renderer(source.data))));
  }
  sourceSection('requests', '行程修改統計', requestsHtml);
  sourceSection('workers', 'Workers Analytics', workersHtml);
  sourceSection('web', 'Web Analytics', webHtml);
  sourceSection('lighthouse', 'Lighthouse 分數', lighthouseHtml);
  sourceSection('sentry', '前端錯誤 (Sentry)', sentryHtml);
  sourceSection('apiLogs', '後端 API 錯誤', apiLogsHtml);
  if (results.sources.links) sections.push(sectionHtml('壞連結檢查', linksHtml(results.sources.links)));
  sourceSection('anomalies', '資料異常', (data) => {
    if (!data) return failedHtml();
    return '<ul>' + data.items.map((item) => '<li>' + escHtml(item) + '</li>').join('') +
      data.failures.map((failure) => '<li>未完成：' + escHtml(failure.query + ' — ' + failure.error) + '</li>').join('') + '</ul>';
  });

  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="' +
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
    'max-width:640px;margin:0 auto;padding:16px;color:#1a1a1a;background:#f8f9fa;">' +
    '<h1 style="font-size:20px;margin:0 0 16px;color:#0f172a;">Tripline 日報 — ' +
    escHtml(results.generatedAt?.slice(0, 10) || formatDate()) + '</h1>' +
    sections.join('') +
    '<p style="margin-top:24px;font-size:12px;color:#94a3b8;">自動產生，由 GitHub Actions 寄出</p>' +
    '</body></html>';
}

function sectionHtml(title, content) {
  return '<div style="background:#fff;border-radius:8px;padding:16px;margin-bottom:12px;">' +
    '<h2 style="font-size:15px;margin:0 0 8px;color:#334155;">' + title + '</h2>' +
    content + '</div>';
}

function failedHtml() {
  return '<p style="color:#ef4444;">查詢失敗</p>';
}

function requestsHtml(data) {
  if (!data) return failedHtml();
  return '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    tr('昨日新增', data.total) +
    tr('已處理', data.closed_count) +
    tr('未處理', data.open_count) +
    '</table>';
}

function workersHtml(data) {
  if (!data) return failedHtml();
  return '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    tr('API 呼叫量', data.requests.toLocaleString()) +
    tr('錯誤數', data.errors) +
    tr('錯誤率', data.requests ? ((data.errors / data.requests) * 100).toFixed(2) + '%' : '0%') +
    tr('P50 延遲', data.p50 + ' ms') +
    tr('P99 延遲', data.p99 + ' ms') +
    '</table>';
}

function webHtml(data) {
  if (!data) return failedHtml();
  return '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    tr('瀏覽量', data.pageViews.toLocaleString()) +
    tr('訪客數', data.visits.toLocaleString()) +
    tr('LCP (P75)', data.lcp === '—' ? '—' : data.lcp + ' ms') +
    tr('CLS (P75)', data.cls === '—' ? '—' : data.cls) +
    tr('INP (P75)', data.inp === '—' ? '—' : data.inp + ' ms') +
    '</table>';
}

function lighthouseHtml(data) {
  if (!data) return failedHtml();
  return '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    tr('Performance', scoreLabel(data.performance)) +
    tr('SEO', scoreLabel(data.seo)) +
    tr('Accessibility', scoreLabel(data.accessibility)) +
    tr('Best Practices', scoreLabel(data.bestPractices)) +
    '</table>';
}

function scoreLabel(score) {
  var color = score >= 90 ? '#16a34a' : score >= 50 ? '#f59e0b' : '#ef4444';
  return '<span style="color:' + color + ';font-weight:600;">' + score + '</span>';
}

function sentryHtml(data) {
  if (!data) return failedHtml();
  var html = '<p style="font-size:14px;margin:0 0 8px;">未解決 issues：<strong>' +
    data.total + '</strong></p>';
  if (data.top3.length > 0) {
    html += '<ul style="margin:0;padding-left:20px;font-size:13px;">';
    data.top3.forEach(function(issue) {
      html += '<li><a href="' + escHtml(issue.link) + '" style="color:#2563eb;">' +
        escHtml(issue.title) + '</a> (' + issue.count + ')</li>';
    });
    html += '</ul>';
  }
  return html;
}

function apiLogsHtml(data) {
  if (!data) return failedHtml();
  var html = '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
    tr('4xx 錯誤', data.summary.count_4xx || 0) +
    tr('5xx 錯誤', data.summary.count_5xx || 0) +
    '</table>';
  if (data.topErrors && data.topErrors.length > 0) {
    html += '<p style="font-size:13px;margin:8px 0 4px;color:#64748b;">Top 錯誤路徑：</p>' +
      '<ul style="margin:0;padding-left:20px;font-size:13px;">';
    data.topErrors.forEach(function(e) {
      html += '<li>' + escHtml(e.path) + ' (' + e.status + ') &times; ' + e.cnt + '</li>';
    });
    html += '</ul>';
  }
  return html;
}


function linksHtml(outcome) {
  if (!outcome) return failedHtml();
  var data = outcome.data;
  var label = outcome.completion === 'partial' ? '部分完成'
    : outcome.completion === 'failed' ? '查詢失敗，檢查未完成'
    : outcome.empty ? '檢查完成，零個可檢查連結'
    : outcome.severity === 'ok' ? '全部連結正常' : '檢查完成，發現壞連結';
  var html = '<p>' + label + '</p>';
  if (outcome.error) html += '<p>' + escHtml(outcome.error) + '</p>';
  if (!data) return html;
  html += '<p>已取得 ' + data.completedTrips + '/' + data.tripCount + ' 個行程；檢查 ' + data.checked + ' 個連結</p>';
  if (data.broken.length) html += '<p style="color:#ef4444;">' + data.broken.length + ' 個壞連結：</p><ul>' +
    data.broken.map((item) => '<li>' + escHtml(item.url) + ' → ' + escHtml(item.status) + '</li>').join('') + '</ul>';
  if (data.failures.length) html += '<ul>' + data.failures.map((failure) =>
    '<li>未完成：' + escHtml(failure.tripId || failure.url) + ' — ' + escHtml(failure.error) + '</li>').join('') + '</ul>';
  return html;
}

function tr(label, value) {
  return '<tr>' +
    '<td style="padding:4px 8px 4px 0;color:#64748b;">' + label + '</td>' +
    '<td style="padding:4px 0;font-weight:600;">' + value + '</td>' +
    '</tr>';
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── 輸出 HTML 檔案（由 GitHub Actions workflow 用 Gmail SMTP 寄出）──

function writeReport(html) {
  var outPath = path.join(__dirname, '..', 'report.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Report written to: ' + outPath);
}

// ── 主流程 ──────────────────────────────────────────────────────

async function main() {
  console.log('Daily report starting — ' + formatDate());

  var results = await runOperations(createReportSources());

  // 組合 HTML 並輸出檔案
  var html = buildHtml(results);
  writeReport(html);
  fs.writeFileSync(path.join(__dirname, '..', 'report.json'), JSON.stringify(results, null, 2), 'utf8');

  // Keep the existing notification audience and anomaly-only delivery policy.
  var anomalies = results.sources.anomalies.data;
  if (anomalies) {
    var alerts = anomalies.items.concat(anomalies.failures.map((failure) => '偵測失敗：' + failure.error));
    if (alerts.length) await sendTelegramAlert(alerts);
  }

  // 清理舊 api_logs（>30 天）
  try {
    await cleanupOldLogs();
    console.log('Old api_logs cleaned up');
  } catch (err) {
    console.error('Cleanup failed:', err);
  }

  console.log('Daily report done');
}

if (require.main === module) main().catch(function(err) {
  console.error('Daily report failed:', err);
  process.exit(1);
});

module.exports = { createReportSources, buildHtml };
