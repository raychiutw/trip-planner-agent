/**
 * v2.31.3 — api-server 內建 cron 排程 pure helper（無 Bun-specific 依賴，方便 unit test）
 *
 * Tripline api-server 內建 setInterval/setTimeout cron 取代 launchd / Cowork。
 * setTimeout 算「下一次每日固定時段」、setInterval 之後每 24h 觸發。
 */

/**
 * 計算下一次每日固定時段距離 `now` 的毫秒數。
 *
 * - 目標時段晚於 now → 排到今天
 * - 目標時段早於 now → 排到明天
 * - 目標時段恰好 == now → 排到明天（24h interval）
 */
export function computeNextDailyFire(now: Date, hour: number, minute: number): { next: Date; delayMs: number } {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return { next, delayMs: next.getTime() - now.getTime() };
}
