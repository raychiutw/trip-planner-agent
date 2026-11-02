/**
 * v2.31.3: scheduleDaily 內建 cron pure helper test
 *
 * 驗證 computeNextDailyFire 對「目標時段 < now」會排到明天，「目標時段 > now」會排到今天。
 */
import { describe, it, expect } from 'vitest';
import { computeNextDailyFire } from '../../scripts/lib/schedule-daily';

describe('computeNextDailyFire', () => {
  it('目標時段晚於 now → 排到今天', () => {
    const now = new Date('2026-05-16T01:00:00.000Z'); // UTC 01:00 = TPE 09:00
    const { next, delayMs } = computeNextDailyFire(now, 18, 0); // 18:00 local
    // delay 應為正數，next 應在 same day（local timezone）或下一個有效時段
    expect(delayMs).toBeGreaterThan(0);
    expect(next.getHours()).toBe(18);
    expect(next.getMinutes()).toBe(0);
  });

  it('目標時段早於 now → 排到明天', () => {
    const now = new Date('2026-05-16T15:00:00.000Z');
    const { next, delayMs } = computeNextDailyFire(now, 8, 0);
    expect(delayMs).toBeGreaterThan(0);
    expect(next.getHours()).toBe(8);
    // 明天 → next 與 now 不同日
    expect(next.getDate()).not.toBe(now.getDate());
  });

  it('目標時段恰好 == now → 排到明天（不是 0ms 立即觸發）', () => {
    const baseHour = 12;
    const baseMin = 30;
    const now = new Date(2026, 4, 16, baseHour, baseMin, 0, 0); // local 12:30:00.000
    const { delayMs } = computeNextDailyFire(now, baseHour, baseMin);
    // 24h interval
    expect(delayMs).toBe(24 * 60 * 60 * 1000);
  });
});
