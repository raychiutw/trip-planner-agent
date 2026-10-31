'use strict';

/**
 * 回傳本地時區下的今日 YYYY-MM-DD 字串。
 *
 * Regression：daily-check.js 原本用 `new Date().toISOString().split('T')[0]`
 * 取「今日」，但這是 UTC 日期。在 UTC+8 凌晨 06:13，UTC 仍是前一天 22:13，
 * 造成 daily-check 06:13 執行時檔名和報告標籤被標成昨天。改用本地 TZ
 * getFullYear/Month/Date 組字串。
 *
 * @param {Date} [now] 可選注入時間（testability）；省略時用 `new Date()`
 * @returns {string} YYYY-MM-DD 本地日期
 */
function todayISO(now) {
  const d = now || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

module.exports = { todayISO };
