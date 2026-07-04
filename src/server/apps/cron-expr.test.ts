import { describe, expect, it } from 'vitest';
import { nextRun, parseCron, validateCron } from './cron-expr';

describe('parseCron', () => {
  it('parses a wildcard expression to full field ranges', () => {
    const spec = parseCron('* * * * *');
    expect(spec.minute.size).toBe(60);
    expect(spec.hour.size).toBe(24);
    expect(spec.dom.size).toBe(31);
    expect(spec.month.size).toBe(12);
    expect(spec.dow.size).toBe(7);
    expect(spec.domRestricted).toBe(false);
    expect(spec.dowRestricted).toBe(false);
  });

  it('parses steps, ranges, lists, and range-with-step', () => {
    expect([...parseCron('*/20 * * * *').minute]).toEqual([0, 20, 40]);
    expect([...parseCron('1-10/3 * * * *').minute]).toEqual([1, 4, 7, 10]);
    expect([...parseCron('1,15,30 * * * *').minute]).toEqual([1, 15, 30]);
    const mixed = parseCron('0 0-6 1,15 * 1-5');
    expect([...mixed.hour]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...mixed.dom]).toEqual([1, 15]);
    expect([...mixed.dow]).toEqual([1, 2, 3, 4, 5]);
    expect(mixed.domRestricted).toBe(true);
    expect(mixed.dowRestricted).toBe(true);
  });

  it('rejects the wrong number of fields', () => {
    expect(() => parseCron('* * * *')).toThrow(/5 fields, got 4/);
    expect(() => parseCron('* * * * * *')).toThrow(/5 fields, got 6/);
    expect(() => parseCron('')).toThrow(/5 fields/);
  });

  it('rejects out-of-range values per field', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/range/);
    expect(() => parseCron('* 24 * * *')).toThrow(/range/);
    expect(() => parseCron('* * 0 * *')).toThrow(/range/);
    expect(() => parseCron('* * 32 * *')).toThrow(/range/);
    expect(() => parseCron('* * * 0 *')).toThrow(/range/);
    expect(() => parseCron('* * * 13 *')).toThrow(/range/);
    expect(() => parseCron('* * * * 7')).toThrow(/range/);
  });

  it('rejects malformed steps, ranges, and trailing junk', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('*/x * * * *')).toThrow(/step/);
    expect(() => parseCron('1/2/3 * * * *')).toThrow(/step/);
    expect(() => parseCron('5-1 * * * *')).toThrow(/range/);
    expect(() => parseCron('1-2-3 * * * *')).toThrow(/range/);
    expect(() => parseCron('5foo * * * *')).toThrow(/range/);
  });
});

describe('validateCron', () => {
  it('returns null for a valid expression', () => {
    expect(validateCron('*/15 9-17 * * 1-5')).toBeNull();
  });

  it('returns the parse error message for an invalid expression', () => {
    expect(validateCron('61 * * * *')).toMatch(/range/);
    expect(validateCron('* * *')).toMatch(/5 fields/);
  });
});

describe('nextRun', () => {
  // All dates are constructed in local time, matching the implementation.
  it('finds the next daily time, rolling to tomorrow when passed', () => {
    const spec = parseCron('30 9 * * *');
    expect(nextRun(spec, new Date(2026, 0, 1, 8, 0))).toEqual(
      new Date(2026, 0, 1, 9, 30),
    );
    expect(nextRun(spec, new Date(2026, 0, 1, 10, 0))).toEqual(
      new Date(2026, 0, 2, 9, 30),
    );
  });

  it('is strictly after `from`, even when `from` matches', () => {
    const spec = parseCron('*/15 * * * *');
    expect(nextRun(spec, new Date(2026, 0, 1, 10, 0, 0))).toEqual(
      new Date(2026, 0, 1, 10, 15),
    );
    // Sub-minute part is truncated before stepping.
    expect(nextRun(spec, new Date(2026, 0, 1, 10, 14, 30))).toEqual(
      new Date(2026, 0, 1, 10, 15),
    );
  });

  it('uses OR semantics when both day-of-month and day-of-week are set', () => {
    // Jan 1 2026 is a Thursday; Jan 2 is a Friday; Jan 13 is a Tuesday.
    const spec = parseCron('0 0 13 * 5');
    expect(nextRun(spec, new Date(2026, 0, 1, 0, 30))).toEqual(
      new Date(2026, 0, 2, 0, 0), // Friday wins (dow match)
    );
    expect(nextRun(spec, new Date(2026, 0, 10, 0, 30))).toEqual(
      new Date(2026, 0, 13, 0, 0), // 13th wins (dom match, Tuesday)
    );
  });

  it('respects a restricted month', () => {
    const spec = parseCron('0 12 * 3 *');
    expect(nextRun(spec, new Date(2026, 0, 1, 0, 0))).toEqual(
      new Date(2026, 2, 1, 12, 0),
    );
  });

  it('returns null when the schedule can never fire (Feb 30)', () => {
    const spec = parseCron('0 0 30 2 *');
    expect(nextRun(spec, new Date(2026, 0, 1, 0, 0))).toBeNull();
  });
});
