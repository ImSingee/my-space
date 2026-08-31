import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_COMPATIBILITY_VERSION,
  LATEST_APP_COMPATIBILITY_VERSION,
  LEGACY_APP_COMPATIBILITY_VERSION,
  MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
  appCompatibility,
  appCompatibilityRollbackMessage,
  appCompatibilityRuntimeMessage,
  resolveAppCompatibilityVersion,
  resolveAppDeployCompatibilityVersion,
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

  it('marks versions newer than the platform latest as unsupported', () => {
    const compatibility = appCompatibility(
      LATEST_APP_COMPATIBILITY_VERSION + 1,
    );

    expect(compatibility).toMatchObject({
      version: LATEST_APP_COMPATIBILITY_VERSION + 1,
      isSupported: false,
      isLatest: false,
    });
    expect(appCompatibilityRuntimeMessage(compatibility)).toMatch(
      new RegExp(
        `newer than this platform's latest supported v${LATEST_APP_COMPATIBILITY_VERSION}.*Update the platform`,
      ),
    );
    expect(appCompatibilityRollbackMessage(compatibility)).toMatch(
      new RegExp(
        `newer than this platform's latest supported v${LATEST_APP_COMPATIBILITY_VERSION}.*Update the platform`,
      ),
    );
  });

  it('uses a fixed v2 default for source manifests that omit compatibility', () => {
    expect(resolveAppDeployCompatibilityVersion(undefined)).toBe(
      DEFAULT_APP_COMPATIBILITY_VERSION,
    );
    expect(DEFAULT_APP_COMPATIBILITY_VERSION).toBe(2);
  });

  it.each([LEGACY_APP_COMPATIBILITY_VERSION, LATEST_APP_COMPATIBILITY_VERSION])(
    'accepts source compatibility v%i within the platform range',
    (version) => {
      expect(resolveAppDeployCompatibilityVersion(version)).toBe(version);
    },
  );

  it('rejects source compatibility below the platform minimum', () => {
    expect(() =>
      resolveAppDeployCompatibilityVersion(
        MIN_SUPPORTED_APP_COMPATIBILITY_VERSION - 1,
      ),
    ).toThrow(/manifest\.json compatibilityVersion.*below.*minimum/);
  });

  it('rejects source compatibility newer than the platform', () => {
    expect(() =>
      resolveAppDeployCompatibilityVersion(
        LATEST_APP_COMPATIBILITY_VERSION + 1,
      ),
    ).toThrow(/manifest\.json compatibilityVersion.*newer.*latest supported/);
  });
});
