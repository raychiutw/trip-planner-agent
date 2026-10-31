#!/usr/bin/env node
/**
 * build-daily-check-msg.js — 從 daily-check report JSON 組裝 Telegram 訊息
 *
 * Usage: node scripts/lib/build-daily-check-msg.js <report.json> [fix-result.json]
 *
 * 抽自 daily-check-scheduler.sh build_telegram_msg() inline node。Cowork
 * migration 後 skill 用 Bash tool 呼此 helper。
 */
const fs = require('fs');

const { summaryText, sourceText } = require('./operations-run');

function buildDailyCheckMessage(r, fixResult) {
  const today = r.date.slice(5).replace('-', '/');
  const lines = [];
  const issues = [];

  // Google Maps 免費額度 headroom helpers（v2.46.x：取代 $ vs $200）
  const gmShort = (m) => String(m || '').split('.').pop();
  const gmWorst = (q) =>
    q && q.worst
      ? `${gmShort(q.worst.method)} ${(q.worst.pct || 0).toFixed(0)}% (${q.worst.usage}/${q.worst.cap})`
      : 'n/a';

  if (r.sources) {
    Object.entries(r.sources).forEach(([name, source]) => {
      if (!source.informational && (source.completion !== 'complete' || source.severity !== 'ok')) {
        issues.push(sourceText(name, source));
      }
    });
  } else {
    if (r.apiErrors && r.apiErrors.error) {
      issues.push(`🔴 API errors 檢查失敗: ${r.apiErrors.error}`);
    } else if (r.apiErrors && r.apiErrors.total > 0) {
      const icon = r.apiErrors.status === 'critical' ? '🔴' : '⚠️';
      issues.push(`${icon} API errors: ${r.apiErrors.total} 筆`);
    }
    if (r.sentry && r.sentry.error) {
      issues.push(`🔴 Sentry 檢查失敗: ${r.sentry.error}`);
    } else if (r.sentry && r.sentry.total > 0) {
      issues.push(`⚠️ Sentry: ${r.sentry.total} 筆`);
    }
    if (r.requestErrors && r.requestErrors.error) {
      issues.push(`🔴 未完成請求檢查失敗: ${r.requestErrors.error}`);
    } else if (r.requestErrors && r.requestErrors.total > 0) {
      const sc = r.requestErrors.statusCounts || {};
      let line = `⚠️ 未完成請求: open:${sc.open || 0} processing:${sc.processing || 0} failed:${sc.failed || 0}`;
      if (r.requestErrors.stuckProcessing > 0) {
        line += ` (${r.requestErrors.stuckProcessing} 卡住>15m)`;
      }
      issues.push(line);
    }
    if (r.schedulerErrors && r.schedulerErrors.total > 0) {
      const parts = [];
      Object.keys(r.schedulerErrors.details).forEach((k) => {
        if (r.schedulerErrors.details[k] && r.schedulerErrors.details[k].count > 0) {
          parts.push(`${k} ${r.schedulerErrors.details[k].count} 筆`);
        }
      });
      issues.push(`⚠️ 排程錯誤: ${parts.join(', ')}`);
    }
    if (r.npmAudit && r.npmAudit.error) {
      issues.push(`🔴 npm audit 失敗: ${r.npmAudit.error}`);
    } else if (r.npmAudit && r.npmAudit.total > 0) {
      const sc = r.npmAudit.severityCounts || {};
      const breakdown = [];
      ['critical', 'high', 'moderate', 'low'].forEach((k) => {
        if (sc[k] > 0) breakdown.push(`${k}:${sc[k]}`);
      });
      const icon = r.npmAudit.status === 'critical' ? '🔴' : '⚠️';
      issues.push(`${icon} npm: ${r.npmAudit.total} 個漏洞 (${breakdown.join(' ')})`);
    }
    if (r.dataHygiene && r.dataHygiene.error) {
      issues.push(`🔴 prod data hygiene 檢查失敗: ${r.dataHygiene.error}`);
    } else if (r.dataHygiene && r.dataHygiene.total > 0) {
      issues.push(`⚠️ prod data hygiene: ${r.dataHygiene.total} 筆 test marker 殘留`);
    }
    // v2.46.x: Google Maps 免費額度 headroom — critical/warning 進 issue 列表
    if (r.googleMapsQuota && r.googleMapsQuota.status === 'critical') {
      const q = r.googleMapsQuota;
      const lock = q.isLocked ? '（已鎖）' : '';
      issues.push(`🔴 Google Maps 免費額度將用罄: ${gmWorst(q)}${lock}`);
    } else if (r.googleMapsQuota && r.googleMapsQuota.status === 'warning' && r.googleMapsQuota.error) {
      // GCP 拿不到 → 顯示錯誤，不顯示假數字（取代舊的 silent swallow）
      issues.push(`🟡 Google Maps 用量監控異常（GCP 無法取得）: ${r.googleMapsQuota.error}`);
    } else if (r.googleMapsQuota && r.googleMapsQuota.status === 'warning') {
      issues.push(`🟡 Google Maps 免費額度接近上限: ${gmWorst(r.googleMapsQuota)}`);
    }

  }

  if (r.sources) {
    lines.push(`📊 ${today} ${summaryText(r.summary)}`);
    issues.forEach((issue) => lines.push(issue));
  } else if (issues.length === 0) {
    lines.push(`📊 ${today} ✅ 全綠`);
  } else {
    lines.push(`📊 Tripline 每日報告 ${today}`);
    lines.push('──────────────');
    issues.forEach((i) => lines.push(i));
  }
  lines.push('──────────────');
  if (r.sources) Object.entries(r.sources).forEach(([name, source]) => {
    if (source.informational && source.completion !== 'complete') lines.push('ℹ️ ' + sourceText(name, source));
  });
  if (r.workers && !r.workers.error) {
    const p50 = Math.round((r.workers.p50 || 0) / 1000);
    const p99 = Math.round((r.workers.p99 || 0) / 1000);
    lines.push(`📈 Workers: ${(r.workers.requests || 0).toLocaleString()} req | err ${r.workers.errors || 0} 筆 | P50 ${p50}ms P99 ${p99}ms`);
  }
  if (r.web && ((r.web.visits || 0) + (r.web.pageViews || 0)) > 0) {
    lines.push(`📈 Analytics: ${r.web.visits} visits, ${r.web.pageViews} views`);
  }
  if (r.npmAudit && !r.npmAudit.error && r.npmAudit.total === 0) {
    lines.push('📈 npm: 0 個漏洞');
  }
  // v2.46.x: Google Maps 免費額度 headroom 放 metrics block（透明 — 含真實付費 $）
  if (r.googleMapsQuota && !r.googleMapsQuota.error && typeof r.googleMapsQuota.maxPct === 'number') {
    const q = r.googleMapsQuota;
    if (!q.worst) {
      // 沒觀測到任何已知計費 method — 對總有流量的本專案可能是 GCP 設定問題，明說別當綠燈
      lines.push('🗺️ Google Maps: 本月未觀測到計費用量（若預期有流量請查 GCP 設定）');
    } else {
      const cost = (q.overageCost || 0) > 0 ? ` · 付費 $${q.overageCost.toFixed(2)}` : ' · $0（免費額度內）';
      lines.push(`🗺️ Google Maps 免費額度: 最高 ${gmWorst(q)}${cost}`);
    }
  }
  const okItems = [];
  if (r.schedulerErrors && r.schedulerErrors.details) {
    Object.keys(r.schedulerErrors.details).forEach((k) => {
      if (r.schedulerErrors.details[k] && r.schedulerErrors.details[k].count === 0) okItems.push(k);
    });
  }
  if (okItems.length > 0) lines.push(`✅ OK: ${okItems.join(', ')}`);

  // 附加修復結果（若 fix-result.json 存在）
  if (fixResult) {
    try {
      if (fixResult.parseError) throw new Error(fixResult.parseError);
      const fr = fixResult;
      if (fr.total === 0) {
        lines.push('🔧 無需修復');
      } else {
        const skipped = (fr.details || []).filter((d) => d.status === 'skipped').length;
        lines.push(`🔨 總計:${fr.total} 已處理:${fr.fixed} 不處理:${skipped}${fr.pr_url ? ` ${fr.pr_url}` : ''}`);
        if (fr.details) {
          fr.details.forEach((d) => {
            const icon = d.status === 'fixed' ? '✅' : d.status === 'skipped' ? '⏭️' : '❌';
            lines.push(`  ${icon} ${d.summary}`);
          });
        }
      }
    } catch (e) {
      lines.push(`⚠️ fix-result 解析失敗: ${e.message}`);
    }
  }

  return lines.join('\n');
}

if (require.main === module) {
  const reportPath = process.argv[2];
  const fixResultPath = process.argv[3];
  if (!reportPath) {
    console.error('Usage: build-daily-check-msg.js <report.json> [fix-result.json]');
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  let fixResult = null;
  if (fixResultPath && fs.existsSync(fixResultPath)) {
    try { fixResult = JSON.parse(fs.readFileSync(fixResultPath, 'utf8')); }
    catch (error) { fixResult = { parseError: error.message }; }
  }
  console.log(buildDailyCheckMessage(report, fixResult));
}

module.exports = { buildDailyCheckMessage };
