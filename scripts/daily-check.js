#!/usr/bin/env node
/**
 * daily-check.js — 每日問題報告腳本
 *
 * 查詢 7 個數據來源 + 排程 error log，產出 JSON 報告。
 * Telegram 發送由 daily-check-scheduler.sh → /tp-daily-check 處理。
 *
 * 環境變數：
 *   CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, D1_DATABASE_ID
 *   SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
 */
'use strict';
var { runOperations, renderOperationsHtml } = require('./lib/operations-run');

var fs = require('fs');
var path = require('path');
var todayISO = require('./lib/local-date').todayISO;

// v2.33.29: .env.local 載入改用 shared scripts/lib/load-env（注入 process.env）
if (require.main === module) require('./lib/load-env').loadEnvLocal();

var googleMapsQuotaLib = require('./lib/google-maps-quota');

// ── D1 REST API helper ──────────────────────────────────────────
// v2.33.29: 移到 scripts/lib/d1-client.js

// ── 日期工具 ────────────────────────────────────────────────────

function createCheckSources(io = {}) {
  var fetch = io.fetch || globalThis.fetch;
  var fs = io.fs || require('fs');
  var execSync = io.execSync || require('child_process').execSync;
  var queryD1 = io.queryD1 || require('./lib/d1-client').queryD1;
  var now = io.now || (() => new Date());
  var env = (key) => (io.env || process.env)[key] || '';
  var CF_TOKEN = env('CLOUDFLARE_API_TOKEN');
  var CF_ACCOUNT = env('CF_ACCOUNT_ID');
  var SENTRY_TOKEN = env('SENTRY_AUTH_TOKEN');
  var SENTRY_ORG = env('SENTRY_ORG');
  var SENTRY_PROJECT = env('SENTRY_PROJECT');
  var TRIPLINE_API_BASE = env('TRIPLINE_API_BASE') || 'https://trip-planner-dby.pages.dev';
  var googleMapsTokenHelper = io.getToken ? { getToken: io.getToken } : (() => {
    try { return require('./lib/get-tripline-token'); } catch (_) { return null; }
  })();

  var DAY_MS = 24 * 60 * 60 * 1000;
  var CLIENT_ERROR_WARNING_THRESHOLD = 5;

  function pastDayWindow() {
    return {
      since: new Date(now().getTime() - DAY_MS).toISOString(),
      until: now().toISOString()
    };
  }

  // ── CF GraphQL 共用 fetch helper ─────────────────────────────────

  async function cfGraphQL(queryStr) {
    var res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: queryStr })
    });
    if (!res.ok) throw new Error('CF GraphQL failed: ' + res.status);
    var data = await res.json();
    if (data.errors?.length || !data?.data?.viewer?.accounts?.[0]) throw new Error('CF GraphQL response unavailable');
    return data.data.viewer.accounts[0];
  }

  // ── 數據來源 1: Sentry 未解決 issues ────────────────────────────

  async function querySentry() {
    var url = 'https://sentry.io/api/0/projects/' + SENTRY_ORG + '/' + SENTRY_PROJECT +
      '/issues/?query=' + encodeURIComponent('is:unresolved lastSeen:-24h');
    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + SENTRY_TOKEN }
    });
    if (!res.ok) throw new Error('Sentry API failed: ' + res.status);
    var issues = await res.json();

    var mapped = issues.map(function(i) {
      return {
        id: i.id,
        title: i.title,
        count: parseInt(i.count, 10) || 0,
        users: (i.userCount) || 0,
        lastSeen: i.lastSeen || '',
        link: i.permalink || ''
      };
    });

    return {
      status: mapped.length > 0 ? 'warning' : 'ok',
      total: mapped.length,
      issues: mapped
    };
  }

  // ── 數據來源 2: D1 api_logs — 昨日 4xx/5xx ──────────────────────

  async function queryApiErrors() {
    // 過濾可預期的 auth/rate-limit 錯誤（401/403/429 屬正常流程），
    // 以及 optional docs 404（useTrip 會靜默略過 DATA_NOT_FOUND docs）、
    // bot 405 probe（unauthenticated 對 GET-only 或不存在 endpoint 試 POST）。
    // v2.30.17：anonymous source 的 405 全 filter — Tripline OAuth 沒有 introspect
    // endpoint、poi-search 是 GET-only，相關 405 都是外部 scanner / bot 嘗試 RFC 7662
    // 或 API discovery，不是真實用戶 bug。
    // v2.55.x：/api/route「Routes empty result」是 Google Routes 回報兩點間無可行駛
    // 路線（如沖繩跨海跳島）。依 P11/T13 刻意 → 502 MAPS_UPSTREAM_FAILED（無 Haversine
    // fallback），前端 useRoute 已優雅降級（隱藏 polyline）。屬預期地理狀況非 code bug，
    // 不該每天觸發 critical。只精確比對此 error 字串 — 真正 upstream 故障（timeout/5xx/
    // parse，error 字串不同）仍照常上報。
    // 2026-09-26：quota-estimate 的 502 MAPS_UPSTREAM_FAILED 是 daily-check 自己打出來的
    //（唯一呼叫端，另有手動 quota:google），當次 run 已由 googleMapsQuota 來源回報；
    // 每天同時段跑、24h 視窗會在隔天撈到同一筆並升級成 critical → 重複告警，故排除。
    var rows = await queryD1(
      "SELECT path, method, status, COUNT(*) as count, MAX(created_at) as lastOccurred " +
      "FROM api_logs " +
      "WHERE created_at >= datetime('now', '-1 day') " +
      "  AND status >= 400 " +
      "  AND status NOT IN (401, 403, 429) " +
      "  AND NOT (status = 404 AND path LIKE '/api/trips/%/docs/%') " +
      "  AND NOT (status = 405 AND source = 'anonymous') " +
      "  AND NOT (status = 502 AND path = '/api/route' AND error = 'MAPS_UPSTREAM_FAILED: Routes empty result') " +
      "  AND NOT (status = 502 AND path = '/api/admin/quota-estimate' AND error = 'MAPS_UPSTREAM_FAILED: Google Cloud Monitoring 無法取得用量（GOOGLE_CLOUD_SA_KEY / GOOGLE_CLOUD_PROJECT_ID 未設定或 API 失敗）') " +
      "GROUP BY path, method, status " +
      "ORDER BY count DESC"
    );

    var total = rows.reduce(function(sum, r) { return sum + (r.count || 0); }, 0);
    var status = 'ok';
    if (total > 0) {
      var has5xx = rows.some(function(r) { return r.status >= 500; });
      status = has5xx
        ? 'critical'
        : (total >= CLIENT_ERROR_WARNING_THRESHOLD ? 'warning' : 'ok');
    }

    return {
      status: status,
      total: total,
      errors: rows.slice(0, 20).map(function(r) {
        return {
          path: r.path,
          method: r.method || 'UNKNOWN',
          status: r.status,
          count: r.count,
          lastOccurred: r.lastOccurred || ''
        };
      })
    };
  }

  // ── 數據來源 3: Workers Analytics ───────────────────────────────

  async function queryWorkersAnalytics() {
    // 絕對 24h 避開 UTC 時區偏移
    var w = pastDayWindow();
    var query = '{ viewer { accounts(filter: {accountTag: "' + CF_ACCOUNT + '"}) { ' +
      'pagesFunctionsInvocationsAdaptiveGroups(limit: 10000, filter: { ' +
      'datetime_geq: "' + w.since + '", ' +
      'datetime_lt: "' + w.until + '" }) { ' +
      'sum { requests errors } ' +
      'quantiles { cpuTimeP50 cpuTimeP99 } ' +
      '} } } }';
    var account = await cfGraphQL(query);
    var row = account?.pagesFunctionsInvocationsAdaptiveGroups?.[0];
    return {
      requests: row?.sum?.requests ?? 0,
      errors: row?.sum?.errors ?? 0,
      p50: Math.round((row?.quantiles?.cpuTimeP50 ?? 0) * 10) / 10,
      p99: Math.round((row?.quantiles?.cpuTimeP99 ?? 0) * 10) / 10
    };
  }

  // ── 數據來源 5: Web Analytics ────────────────────────────────────

  async function queryWebAnalytics() {
    var w = pastDayWindow();
    var query = '{ viewer { accounts(filter: {accountTag: "' + CF_ACCOUNT + '"}) { ' +
      'rumPageloadEventsAdaptiveGroups(limit: 1, filter: { ' +
      'datetime_geq: "' + w.since + '", ' +
      'datetime_lt: "' + w.until + '" }) { ' +
      'count sum { visits } ' +
      '} } } }';
    var account = await cfGraphQL(query);
    var row = account?.rumPageloadEventsAdaptiveGroups?.[0];
    return {
      visits: row?.sum?.visits ?? 0,
      pageViews: row?.count ?? 0
    };
  }

  // ── 數據來源 5b: Route health（B-P6 task 10.3）─────────────────────
  // 驗證主要 SPA routes prod 上回 < 500（Cloudflare Access 的 302 / SPA 200 都算 OK）

  async function queryRouteHealth() {
    var BASE = 'https://trip-planner-dby.pages.dev';
    var ROUTES = [
      '/',
      '/manage/',
      '/admin/',
      '/trip/okinawa-trip-2026-Ray',
      '/explore',
      '/login',
      '/map',
      '/chat',
    ];
    var checks = await Promise.all(ROUTES.map(async function(r) {
      try {
        var res = await fetch(BASE + r, { redirect: 'manual' });
        return { route: r, status: res.status, ok: res.status < 500 };
      } catch (e) {
        return { route: r, status: 0, ok: false, error: (e && e.message) || String(e) };
      }
    }));
    var failed = checks.filter(function(c) { return !c.ok; });
    return {
      status: failed.length === 0
        ? 'ok'
        : (failed.length >= Math.ceil(checks.length / 2) ? 'critical' : 'warning'),
      total: failed.length,
      completion: checks.every((check) => !check.error) ? 'complete' : checks.some((check) => !check.error) ? 'partial' : 'failed',
      checked: checks.length,
      routes: checks,
    };
  }

  // ── 數據來源 6: npm audit ────────────────────────────────────────

  function queryNpmAudit() {
    try {
      // v2.33.51 round 8c: add maxBuffer — npm audit on deps-heavy project routinely
      // 吐 multi-MB JSON。default 1MB → throw ENOBUFS (timeout/buffer 都不算 shell
      // error，`; true` 無法 recover)。32MB 是 npm audit typical output 上限。
      // v2.57.89: registry bulk advisories endpoint 實測單次要 ~50s（2026-09-04 甚至整個黑洞），
      // 60s 貼著邊跑會週期性 ETIMEDOUT 假 critical。放寬到 180s；真的黑洞仍會 fail-loud。
      var output = execSync('npm audit --json --omit=dev 2>/dev/null; true', {
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 32 * 1024 * 1024,
        cwd: path.join(__dirname, '..')
      });
      var parsed = output.trim() ? JSON.parse(output) : {};
      if (parsed.error || !parsed.vulnerabilities || typeof parsed.vulnerabilities !== 'object') throw new Error('npm audit returned no vulnerability report');

      var vulns = [];
      if (parsed.vulnerabilities) {
        Object.keys(parsed.vulnerabilities).forEach(function(pkgName) {
          var v = parsed.vulnerabilities[pkgName];
          if (v.severity && v.severity !== 'info') {
            vulns.push({ package: pkgName, severity: v.severity });
          }
        });
      }

      var severityCounts = { critical: 0, high: 0, moderate: 0, low: 0 };
      vulns.forEach(function(v) {
        if (severityCounts[v.severity] !== undefined) severityCounts[v.severity]++;
      });

      var status = vulns.length === 0
        ? 'ok'
        : (severityCounts.critical + severityCounts.high > 0 ? 'critical' : 'warning');

      return {
        status: status,
        total: vulns.length,
        severityCounts: severityCounts,
        vulnerabilities: vulns
      };
    } catch (err) {
      console.error('npm audit failed:', err.message);
      // Fail loud: critical + error message in Telegram
      return {
        status: 'critical',
        total: 0,
        severityCounts: { critical: 0, high: 0, moderate: 0, low: 0 },
        vulnerabilities: [],
        error: 'npm audit 執行失敗: ' + String(err.message || err).slice(0, 120)
      };
    }
  }

  // ── 數據來源 7: tp-request 錯誤統計 ─────────────────────────────

  async function queryRequestErrors() {
    // 只看過去 24h 內的非 completed 請求（陳年 failed 會自然淡出）
    // 使用者 15 分鐘內就取消 = 改變主意，不算故障；等滿 15 分鐘才取消多半是 AI 沒回
    // （10/27 #285），照報。只認 status=failed 的取消：單帶 terminalReason 的 PATCH
    // 能讓還在跑的請求掛上 cancelled。IFNULL 讓 NULL 照報。
    var rows = await queryD1(
      "SELECT id, trip_id, status, substr(message, 1, 80) as message, " +
      "substr(reply, 1, 80) as reply, created_at " +
      "FROM trip_requests " +
      "WHERE status != 'completed' " +
      "  AND NOT (status = 'failed' AND IFNULL(terminal_reason, '') = 'cancelled' " +
      "    AND COALESCE(updated_at, created_at) < datetime(created_at, '+15 minutes')) " +
      "  AND created_at >= datetime('now', '-1 day') " +
      "ORDER BY created_at DESC"
    );

    var statusCounts = { open: 0, processing: 0, failed: 0 };
    rows.forEach(function(r) {
      if (statusCounts[r.status] !== undefined) statusCounts[r.status]++;
    });

    // processing > 15min 視為卡住（Claude CLI 執行途中掛掉）
    var stuckCutoff = now().getTime() - 15 * 60 * 1000;
    var stuckProcessing = rows.filter(function(r) {
      // D1 naive datetime ('YYYY-MM-DD HH:MM:SS', no Z) must be read as UTC, else
      // it parses as local time and skews the stuck-cutoff by the tz offset.
      var createdUtc = r.created_at.includes('T') || r.created_at.endsWith('Z') ? r.created_at : r.created_at.replace(' ', 'T') + 'Z';
      return r.status === 'processing' && new Date(createdUtc).getTime() < stuckCutoff;
    }).length;

    var status = rows.length > 0 ? 'warning' : 'ok';

    return {
      status: status,
      total: rows.length,
      statusCounts: statusCounts,
      stuckProcessing: stuckProcessing,
      pending: rows.slice(0, 20).map(function(r) {
        return {
          id: r.id,
          tripId: r.trip_id,
          status: r.status,
          message: r.message || '',
          reply: r.reply || '',
          createdAt: r.created_at
        };
      })
    };
  }

  // ── 數據來源 8: audit_log 異常 mutation pattern (v2.33.132 G14) ──
  //
  // 偵測過去 24h 內 mutation 突發：可能是 script abuse / 程式 bug 寫 loop /
  // restore 失敗反覆 retry。Surface 進每日報告，不阻擋（沒有 auto-fix path）。
  //
  // Threshold（保守 — 偽陽性比偽陰性糟，這 alert 給人 triage）：
  //   - per user_id 24h > 200 mutation → warning（一般使用者 < 50/day）
  //   - per trip_id 24h > 100 mutation → warning（重度編輯也 < 50；超過 100
  //     表示 thrash loop）
  //   - delete 在 trip / users 表 > 10 → critical（這些 table delete 罕見）
  var AUDIT_USER_MUTATION_WARNING = 200;
  var AUDIT_TRIP_MUTATION_WARNING = 100;
  var AUDIT_DELETE_CRITICAL = 10;

  async function queryAuditAnomaly() {
    var oneDayAgo = "datetime('now', '-1 day')";

    // Heavy user actors（changed_by_user_id 可能 NULL for service token）
    var heavyUsers = await queryD1(
      "SELECT changed_by_user_id AS userId, changed_by AS actor, COUNT(*) AS mutations " +
      "FROM audit_log " +
      "WHERE created_at >= " + oneDayAgo + " " +
      "  AND changed_by_user_id IS NOT NULL " +
      "GROUP BY changed_by_user_id " +
      "HAVING COUNT(*) > " + AUDIT_USER_MUTATION_WARNING + " " +
      "ORDER BY mutations DESC " +
      "LIMIT 10"
    );

    var heavyTrips = await queryD1(
      "SELECT trip_id AS tripId, COUNT(*) AS mutations " +
      "FROM audit_log " +
      "WHERE created_at >= " + oneDayAgo + " " +
      "  AND trip_id != 'system' " +
      "GROUP BY trip_id " +
      "HAVING COUNT(*) > " + AUDIT_TRIP_MUTATION_WARNING + " " +
      "ORDER BY mutations DESC " +
      "LIMIT 10"
    );

    // critical table delete spike — table_name IN ('trips', 'users')
    var criticalDeletes = await queryD1(
      "SELECT table_name AS tableName, COUNT(*) AS deletes " +
      "FROM audit_log " +
      "WHERE created_at >= " + oneDayAgo + " " +
      "  AND action = 'delete' " +
      "  AND table_name IN ('trips', 'users') " +
      "GROUP BY table_name " +
      "HAVING COUNT(*) > " + AUDIT_DELETE_CRITICAL
    );

    var status = 'ok';
    if (criticalDeletes.length > 0) {
      status = 'critical';
    } else if (heavyUsers.length > 0 || heavyTrips.length > 0) {
      status = 'warning';
    }

    return {
      status: status,
      heavyUsers: heavyUsers,
      heavyTrips: heavyTrips,
      criticalDeletes: criticalDeletes,
      thresholds: {
        userMutationWarning: AUDIT_USER_MUTATION_WARNING,
        tripMutationWarning: AUDIT_TRIP_MUTATION_WARNING,
        deleteCritical: AUDIT_DELETE_CRITICAL,
      },
    };
  }

  // ── 數據來源 7: 排程 error log ────────────────────────────────

  function querySchedulerErrors() {
    // 每 dir 最多收集 N 筆錯誤樣本顯示，但 count 記錄真實總數（不受上限影響）
    var MAX_ERROR_SAMPLES = 5;
    var MAX_MESSAGE_LEN = 100;
    var cutoff = new Date(now().getTime() - DAY_MS);
    var baseDir = path.join(__dirname, 'logs');

    // v2.30.5 Cowork migration 後 tp-request / daily-check 跑在 Claude Desktop session 內，
    // 失敗 surface 在 Telegram + fix-result.json，不再寫 .error.log。剩 api-server LaunchAgent。
    var schedulers = [
      { name: 'api-server',  type: 'stderr' },
    ];

    var details = {};
    var totalErrors = 0;
    var scanErrors = [];

    schedulers.forEach(function(s) {
      var result = { count: 0, errors: [] };
      try {
        if (s.type === 'error-log') {
          var dirPath = path.join(baseDir, s.name);
          var files = fs.readdirSync(dirPath).filter(function(f) { return f.endsWith('.error.log'); });
          files.forEach(function(f) {
            var filePath = path.join(dirPath, f);
            var stat = fs.statSync(filePath);
            if (stat.mtime < cutoff) return;
            var content = fs.readFileSync(filePath, 'utf8').trim();
            if (!content) return;
            content.split('\n').forEach(function(line) {
              var match = line.match(/^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+Z?)?)\] \[error\] (.+)/);
              if (match) {
                var ts = new Date(match[1].replace(' ', 'T'));
                if (ts >= cutoff) {
                  result.count++;
                  if (result.errors.length < MAX_ERROR_SAMPLES) {
                    result.errors.push({ time: match[1], message: match[2].substring(0, MAX_MESSAGE_LEN) });
                  }
                }
              }
            });
          });
        } else if (s.type === 'stderr') {
          // Long-running process 無時戳 stderr：用 mtime 近似「24h 內被寫入」，
          // 只讀檔尾 8KB 避免大檔案 OOM
          var stderrPath = path.join(baseDir, s.name, 'stderr.log');
          var stat = fs.statSync(stderrPath);
          if (stat.size > 0 && stat.mtime >= cutoff) {
            var tailSize = Math.min(stat.size, 8192);
            var buf = Buffer.alloc(tailSize);
            var fd = fs.openSync(stderrPath, 'r');
            try {
              fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
            } finally {
              fs.closeSync(fd);
            }
            var lastLine = buf.toString('utf8').trim().split('\n').pop() || '';
            result.count = 1;
            result.errors = [{ time: '', message: lastLine.substring(0, MAX_MESSAGE_LEN) }];
          }
        }
      } catch (e) {
        // ENOENT = 檔案/目錄不存在 = 健康狀態，其他 error 才 log
        if (e.code !== 'ENOENT') {
          console.error('schedulerErrors scan failed for ' + s.name + ':', e.message);
          scanErrors.push(s.name + ': ' + e.message);
        }
      }
      details[s.name] = result;
      totalErrors += result.count;
    });

    return {
      status: totalErrors > 0 ? 'warning' : 'ok',
      total: totalErrors,
      details: details,
      ...(scanErrors.length ? { error: scanErrors.join('; ') } : {})
    };
  }

  // ── Prod data hygiene ──────────────────────────────────────────────
  // mockup-parity-qa-fixes Sprint 7.2: 偵測 prod trip data 含 known test marker
  // （e.g. TEST_AUTO_UPDATE_PROBE 在 v2 deeper QA 發現 leak 進 Ray's trip Day 04）。
  // 找到就 warn，提醒 manually clean up via API DELETE。

  var PROD_DATA_TEST_MARKERS = [
    'TEST_AUTO_UPDATE_PROBE',
    '_PROBE',
    'AUTO_TEST_FIXTURE',
    '__TEST_ONLY__'
  ];

  async function queryProdDataHygiene() {
    try {
      var likeClauses = PROD_DATA_TEST_MARKERS.map(function(marker) {
        // SQL injection-safe: marker 是 hardcoded constant，不接 user input
        // migration 0078: trip_entries.note 已 DROP — 備註改 per-(entry, poi)
        // trip_entry_pois.note。marker 掃描改讀 master（sort_order=1）的 per-POI note，
        // 繼承原本「整體備註」的語意。
        var safe = marker.replace(/'/g, "''");
        return "te.description LIKE '%" + safe + "%' OR tep.note LIKE '%" + safe + "%'";
      }).join(' OR ');
      // trip_id / day_num 在 trip_days,需 JOIN(trip_entries 只有 day_id)。
      // trip_entries 無 title 欄，entry 層自由文字在 description（migration 0078 後
      // note 已移到 per-POI）；掃 description + master POI note。
      // note 在 master trip_entry_pois row（sort_order=1）— LEFT JOIN 避免無 POI 的
      // placeholder entry 因 note 掃描被整列濾掉（description marker 仍可命中）。
      var sql = 'SELECT te.id, td.trip_id, td.day_num, te.description AS title, tep.note AS note ' +
        'FROM trip_entries te JOIN trip_days td ON te.day_id = td.id ' +
        'LEFT JOIN trip_entry_pois tep ON tep.entry_id = te.id AND tep.sort_order = 1 ' +
        'WHERE ' + likeClauses + ' LIMIT 50';
      var rows = await queryD1(sql);
      if (!rows || rows.length === 0) {
        return { status: 'ok', total: 0, leaks: [] };
      }
      return {
        status: 'warning',
        total: rows.length,
        leaks: rows.map(function(r) {
          return {
            entryId: r.id,
            tripId: r.trip_id,
            dayNum: r.day_num,
            title: r.title,
            marker: PROD_DATA_TEST_MARKERS.find(function(m) {
              return (r.title && r.title.indexOf(m) >= 0) || (r.note && r.note.indexOf(m) >= 0);
            })
          };
        })
      };
    } catch (err) {
      // check 失敗本身就該 surface,別假裝綠燈遮蓋 silent failure
      console.error('Prod data hygiene check failed:', err.message);
      return { status: 'warning', total: 0, leaks: [], error: err.message };
    }
  }

  // ── 數據來源 8: Google Maps quota (v2.31.96) ─────────────────────
  // google-quota-monitor.ts 原本是 launchd-only 孤兒，這裡把 MTD 花費 +
  // 鎖狀態整合進 daily-check，讓 Telegram 每日報告看得到金額。
  // 計算邏輯抽到 lib/google-maps-quota.js 共用（drift test 守住）。

  async function adminApiGet(pathname, token) {
    var res = await fetch(TRIPLINE_API_BASE + pathname, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error(pathname + ' returned ' + res.status);
    return res.json();
  }

  async function queryGoogleMapsQuota() {
    // token helper 缺 / .env.local 沒 CLIENT_ID/SECRET → skip silently（本機 dev 可能沒 cred）
    if (!googleMapsTokenHelper || typeof googleMapsTokenHelper.getToken !== 'function') {
      return { status: 'ok', error: 'token helper unavailable (skip)' };
    }
    if (!env('TRIPLINE_API_CLIENT_ID') || !env('TRIPLINE_API_CLIENT_SECRET')) {
      return { status: 'ok', error: 'TRIPLINE_API_CLIENT_ID/SECRET missing (skip)' };
    }
    try {
      var token = await googleMapsTokenHelper.getToken();
      var settings = await adminApiGet('/api/admin/maps-settings', token);
      // quota-estimate 回 month-to-date 真實 per-method counts（GCP Cloud Monitoring）。
      // GCP 拿不到 → endpoint 回 502 → adminApiGet throw → catch 顯示 error。
      var estimates = await adminApiGet('/api/admin/quota-estimate', token);
      // 2025/3 起 Maps 取消 $200 抵免、改每個 SKU 各自免費月額度 → 監控 headroom
      //（用掉免費額度 %）而非 $ vs 預算。任一 SKU ≥ CRITICAL_PCT → critical、
      // ≥ WARN_PCT → warning，在跨入付費前預警。overageCost 是真實付費 $（現為 0）。
      // 2026-07-29：門檻從 app_settings 搬進 lib 寫死（那組 key 建立在已取消的
      // $200 抵免模型上）。settings 現在只剩鎖定狀態。
      var headroom = googleMapsQuotaLib.calcHeadroom(estimates);
      var criticalPct = googleMapsQuotaLib.CRITICAL_PCT;
      var status = googleMapsQuotaLib.classifyStatus(headroom.maxPct, criticalPct);
      return {
        status: status,
        maxPct: headroom.maxPct,
        worst: headroom.worst,
        overageCost: headroom.overageCostTotal,
        criticalPct: criticalPct,
        warnPct: googleMapsQuotaLib.WARN_PCT,
        isLocked: !!settings.is_locked,
        services: headroom.items
      };
    } catch (err) {
      console.error('Google Maps quota check failed:', err.message);
      return { status: 'warning', error: err.message };
    }
  }


  function check(run, options = {}) {
    return { run, ...options, assess: (data) => ({
      completion: data.completion || (data.error ? 'failed' : 'complete'),
      severity: data.status || (data.error ? 'warning' : 'ok'),
      ...(data.error ? { error: data.error } : {}),
    }) };
  }
  return {
    // Keep the existing synchronous audit/log scan before starting network reads.
    npmAudit: check(queryNpmAudit, { failureSeverity: 'critical' }),
    schedulerErrors: check(querySchedulerErrors),
    sentry: check(querySentry),
    apiErrors: check(queryApiErrors),
    workers: check(queryWorkersAnalytics, { required: false, informational: true }),
    web: check(queryWebAnalytics, { required: false, informational: true }),
    requestErrors: check(queryRequestErrors),
    routeHealth: check(queryRouteHealth),
    dataHygiene: check(queryProdDataHygiene),
    googleMapsQuota: check(queryGoogleMapsQuota, { required: !!(env('TRIPLINE_API_CLIENT_ID') && env('TRIPLINE_API_CLIENT_SECRET')) }),
    auditAnomaly: check(queryAuditAnomaly),
  };
}

// ── 流水編號產生器 ───────────────────────────────────────────────

function makeCounter() {
  var n = 0;
  return function() { return ++n; };
}

// ── JSON 加編號（就地修改各來源的 issue/error 項目）──────────────

function assignNums(report) {
  var counter = makeCounter();

  if (report.sentry && report.sentry.issues) {
    report.sentry.issues.forEach(function(i) { i.num = counter(); });
  }
  if (report.apiErrors && report.apiErrors.errors) {
    report.apiErrors.errors.forEach(function(e) { e.num = counter(); });
  }
  if (report.requestErrors && report.requestErrors.pending) {
    report.requestErrors.pending.forEach(function(p) { p.num = counter(); });
  }
  if (report.dataHygiene && report.dataHygiene.leaks) {
    report.dataHygiene.leaks.forEach(function(l) { l.num = counter(); });
  }

  report._maxNum = counter() - 1;
}

// ── Log rotation ────────────────────────────────────────────────

function rotateOldLogs(logsDir) {
  try {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    var files = fs.readdirSync(logsDir);
    files.forEach(function(f) {
      if (!f.endsWith('-report.json') && !f.endsWith('-report.html') && !(f.startsWith('daily-check-') && f.endsWith('.json'))) return;
      var fullPath = path.join(logsDir, f);
      var stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff.getTime()) {
        fs.unlinkSync(fullPath);
        console.log('Deleted old log: ' + f);
      }
    });
  } catch (err) {
    console.error('Log rotation failed:', err.message);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────

async function main() {
  var today = todayISO();
  console.log('Daily check starting — ' + today);

  var run = await runOperations(createCheckSources());
  // Retain the established top-level fields for consumers of historical reports.
  var report = { date: today, ...run };
  Object.entries(run.sources).forEach(([name, source]) => {
    report[name] = source.data || { error: source.error, status: source.severity };
  });
  var summary = run.summary;

  // 為所有 issue/error 項目加流水編號
  assignNums(report);

  // 確保 logs 目錄存在
  var logsDir = path.join(__dirname, 'logs', 'daily-check');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // 寫出 JSON
  var outPath = path.join(logsDir, today + '-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(logsDir, today + '-report.html'), renderOperationsHtml(run), 'utf8');
  console.log('Report written to: ' + outPath);

  // Log rotation（刪除 7 天前的 JSON）
  rotateOldLogs(logsDir);

  console.log('Daily check done — ' + JSON.stringify(summary));
}

if (require.main === module) main().catch(function(err) {
  console.error('Daily check failed:', err);
  process.exit(1);
});

module.exports = { createCheckSources };
