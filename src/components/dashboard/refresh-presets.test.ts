import { describe, expect, it } from 'vitest';
import {
  MAX_REFRESH_SECONDS,
  REFRESH_PRESETS,
  clampRefreshSeconds,
  formatInterval,
} from './refresh-presets';

describe('REFRESH_PRESETS', () => {
  it('starts with an Off (0s) option and is strictly increasing', () => {
    expect(REFRESH_PRESETS[0]).toEqual({ label: 'Off', seconds: 0 });
    for (let i = 1; i < REFRESH_PRESETS.length; i++) {
      expect(REFRESH_PRESETS[i].seconds).toBeGreaterThan(
        REFRESH_PRESETS[i - 1].seconds,
      );
    }
  });
});

describe('formatInterval', () => {
  it('uses the preset label when the value matches a preset', () => {
    expect(formatInterval(0)).toBe('Off');
    expect(formatInterval(30)).toBe('30s');
    expect(formatInterval(300)).toBe('5m');
    expect(formatInterval(3600)).toBe('1h');
  });

  it('falls back to a compact unit for non-preset values', () => {
    expect(formatInterval(90)).toBe('90s');
    expect(formatInterval(120)).toBe('2m');
    expect(formatInterval(7200)).toBe('2h');
  });

  it('prefers hours, then minutes, then seconds', () => {
    // 120 is divisible by 60 but not 3600 → minutes.
    expect(formatInterval(120)).toBe('2m');
    // 45 is divisible by neither → seconds.
    expect(formatInterval(45)).toBe('45s');
  });
});

describe('clampRefreshSeconds', () => {
  it('passes through valid whole seconds', () => {
    expect(clampRefreshSeconds(0)).toBe(0);
    expect(clampRefreshSeconds(30)).toBe(30);
    expect(clampRefreshSeconds(3600)).toBe(3600);
  });

  it('floors fractional values toward zero', () => {
    expect(clampRefreshSeconds(30.9)).toBe(30);
    expect(clampRefreshSeconds(0.4)).toBe(0);
  });

  it('clamps negatives to zero (off)', () => {
    expect(clampRefreshSeconds(-5)).toBe(0);
    expect(clampRefreshSeconds(-0.1)).toBe(0);
  });

  it('treats non-finite input as off', () => {
    expect(clampRefreshSeconds(Number.NaN)).toBe(0);
    expect(clampRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampRefreshSeconds(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('caps oversized input at MAX_REFRESH_SECONDS to avoid timer overflow', () => {
    expect(MAX_REFRESH_SECONDS).toBe(3600);
    expect(clampRefreshSeconds(MAX_REFRESH_SECONDS)).toBe(MAX_REFRESH_SECONDS);
    expect(clampRefreshSeconds(999_999)).toBe(MAX_REFRESH_SECONDS);
    // Above the browser's signed-32-bit setInterval limit (~2.1e9 ms).
    expect(clampRefreshSeconds(2_147_483_648)).toBe(MAX_REFRESH_SECONDS);
  });
});
