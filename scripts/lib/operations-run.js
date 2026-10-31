'use strict';

/** Run real source adapters once; all consumers share completion and severity.
 * Transport, retries, timeouts and thresholds remain with each source adapter.
 */
async function runOperations(definitions, options = {}) {
  const entries = await Promise.all(Object.entries(definitions).map(async ([name, definition]) => {
    const base = { required: definition.required !== false, informational: !!definition.informational };
    try {
      const data = await definition.run();
      const assessment = definition.assess ? definition.assess(data) : {};
      return [name, { ...base, completion: 'complete', severity: 'ok', empty: data == null || (Array.isArray(data) && data.length === 0), data: data ?? null, ...assessment }];
    } catch (error) {
      return [name, { ...base, completion: 'failed', severity: definition.failureSeverity || 'warning', empty: false, data: null, error: String(error?.message || error) }];
    }
  }));
  const sources = Object.fromEntries(entries);
  const required = Object.values(sources).filter((source) => source.required);
  const alerts = Object.values(sources).filter((source) => !source.informational);
  const completion = required.every((source) => source.completion === 'complete') ? 'complete'
    : required.some((source) => source.completion !== 'failed') ? 'partial' : 'failed';
  const critical = alerts.filter((source) => source.severity === 'critical').length;
  const warning = alerts.filter((source) => source.severity === 'warning').length;
  const empty = required.length === 0 || (completion === 'complete' && required.every((source) => source.empty));
  const summary = {
    completion, empty, healthy: completion === 'complete' && !empty && critical + warning === 0,
    severity: critical ? 'critical' : warning ? 'warning' : 'ok',
    totalIssues: critical + warning, critical, warning,
    ok: alerts.filter((source) => source.completion === 'complete' && source.severity === 'ok').length,
    unavailableInformation: Object.values(sources).filter((source) => source.informational && source.completion !== 'complete').length,
    incomplete: required.filter((source) => source.completion !== 'complete').length,
  };
  return { generatedAt: (options.now || (() => new Date()))().toISOString(), sources, summary };
}

function summaryText(summary) {
  const completion = summary.completion === 'partial' ? '部分完成'
    : summary.completion === 'failed' ? '必要檢查全數失敗' : summary.empty ? '檢查完成，零資料' : '必要檢查完整';
  return completion + (summary.healthy ? '；全部健康' : '；' + summary.critical + ' 項嚴重、' + summary.warning + ' 項警告') + (summary.unavailableInformation ? '；' + summary.unavailableInformation + ' 個資訊來源未完成' : '');
}

function sourceText(name, source) {
  const completion = source.completion === 'complete' ? (source.empty ? '零資料' : '完整')
    : source.completion === 'partial' ? '部分完成' : '未完成';
  return name + '：' + completion + '；' + source.severity +
    (source.informational ? '（資訊）' : '') + (source.error ? '；' + source.error : '');
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderOperationsHtml(run) {
  return '<!DOCTYPE html><html lang="zh-Hant"><meta charset="utf-8"><body><h1>' +
    escapeHtml(summaryText(run.summary)) + '</h1>' + Object.entries(run.sources).map(([name, source]) =>
      '<section><h2>' + escapeHtml(sourceText(name, source)) + '</h2><pre>' +
      escapeHtml(JSON.stringify(source.data, null, 2)) + '</pre></section>').join('') + '</body></html>';
}

module.exports = { runOperations, summaryText, sourceText, renderOperationsHtml };
