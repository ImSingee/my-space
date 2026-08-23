import { describe, expect, it } from 'vitest';
import {
  MAX_REFRESH_SECONDS,
  clampRefreshSeconds,
  formatInterval,
} from './refresh-presets';

describe('formatInterval', () => {
  it('formats disabled, second, minute, and hour intervals', () => {
    expect(formatInterval(0)).toBe('Off');
    expect(formatInterval(45)).toBe('45s');
    expect(formatInterval(120)).toBe('2m');
    expect(formatInterval(7200)).toBe('2h');
  });
});

describe('clampRefreshSeconds', () => {
  it('normalizes unsafe timer inputs within the supported range', () => {
    expect(clampRefreshSeconds(30.9)).toBe(30);
    expect(clampRefreshSeconds(-5)).toBe(0);
    expect(clampRefreshSeconds(Number.NaN)).toBe(0);
    expect(clampRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampRefreshSeconds(999_999)).toBe(MAX_REFRESH_SECONDS);
  });
});
