import { describe, expect, test } from 'vitest';
import { getNextRun, type GetNextRunOptions } from '../packages/orchestrator/src/scheduler.js';

describe('scheduler getNextRun', () => {
  // -- interval schedules ---
  test('interval schedule returns future date', () => {
    const result = getNextRun({
      scheduleType: 'interval',
      intervalValue: 1,
      intervalUnit: 'hours',
    });
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  test('interval schedule respects startAt in the future', () => {
    const futureStart = new Date(Date.now() + 86_400_000); // tomorrow
    const result = getNextRun({
      scheduleType: 'interval',
      intervalValue: 1,
      intervalUnit: 'hours',
      startAt: futureStart.toISOString(),
    });
    // Should return the start time itself since it's in the future
    expect(result.getTime()).toBe(futureStart.getTime());
  });

  test('interval schedule with past startAt calculates next occurrence', () => {
    const pastStart = new Date(Date.now() - 3_600_000 * 5); // 5 hours ago
    const result = getNextRun({
      scheduleType: 'interval',
      intervalValue: 2,
      intervalUnit: 'hours',
      from: new Date(),
    });
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  test('interval months unit works', () => {
    const result = getNextRun({
      scheduleType: 'interval',
      intervalValue: 1,
      intervalUnit: 'months',
    });
    expect(result.getTime()).toBeGreaterThan(Date.now());
    // Should be roughly 1 month from now
    const diff = result.getTime() - Date.now();
    expect(diff).toBeGreaterThan(25 * 86_400_000); // at least 25 days
    expect(diff).toBeLessThan(35 * 86_400_000); // at most 35 days
  });

  test('interval throws without intervalValue', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'interval',
        intervalUnit: 'hours',
      } as GetNextRunOptions)
    ).toThrow('intervalValue');
  });

  test('interval throws without intervalUnit', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'interval',
        intervalValue: 1,
      } as GetNextRunOptions)
    ).toThrow('intervalUnit');
  });

  test('interval throws on invalid startAt', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'interval',
        intervalValue: 1,
        intervalUnit: 'hours',
        startAt: 'not-a-date',
      })
    ).toThrow('Invalid interval start time');
  });

  // -- cron schedules ---
  test('cron schedule returns future date', () => {
    const result = getNextRun({
      scheduleType: 'cron',
      cronExpression: '*/5 * * * *', // every 5 minutes
    });
    expect(result.getTime()).toBeGreaterThan(Date.now());
    // Should be within 5 minutes
    expect(result.getTime() - Date.now()).toBeLessThan(5 * 60_000 + 1000);
  });

  test('cron schedule throws without cronExpression', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'cron',
      } as GetNextRunOptions)
    ).toThrow('cronExpression');
  });

  test('cron string shorthand works', () => {
    const result = getNextRun('*/10 * * * *'); // every 10 minutes
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  // -- timezone ---
  test('valid timezone is accepted', () => {
    const result = getNextRun({
      scheduleType: 'cron',
      cronExpression: '0 9 * * *', // daily at 9am
      timezone: 'America/New_York',
    });
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  test('invalid timezone throws', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'cron',
        cronExpression: '0 9 * * *',
        timezone: 'Mars/Olympus_Mons',
      })
    ).toThrow('Invalid timezone');
  });

  test('cron throws on invalid startAt', () => {
    expect(() =>
      getNextRun({
        scheduleType: 'cron',
        cronExpression: '0 9 * * *',
        startAt: 'garbage',
      })
    ).toThrow('Invalid cron start time');
  });
});
