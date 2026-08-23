import { describe, expect, it } from 'vitest';
import {
  LATEST_APP_COMPATIBILITY_VERSION,
  LEGACY_APP_COMPATIBILITY_VERSION,
  MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
  appCompatibility,
  resolveAppCompatibilityVersion,
} from './app-compatibility';

describe('App compatibility', () => {
  it('treats a missing legacy deployment field as v1', () => {
    expect(resolveAppCompatibilityVersion(null)).toBe(
      LEGACY_APP_COMPATIBILITY_VERSION,
    );
    expect(appCompatibility(undefined)).toMatchObject({
      version: 1,
      isSupported: true,
      isLatest: false,
    });
  });

  it('marks new v2 deployments as current and supported', () => {
    expect(appCompatibility(LATEST_APP_COMPATIBILITY_VERSION)).toEqual({
      version: 2,
      latestVersion: 2,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    });
  });

  it('marks versions below the minimum as unsupported', () => {
    const compatibility = appCompatibility(
      MIN_SUPPORTED_APP_COMPATIBILITY_VERSION - 1,
    );
    expect(compatibility.isSupported).toBe(false);
    expect(compatibility.isLatest).toBe(false);
  });
});
