import { describe, expect, test } from 'vitest';
import { getAppViewState } from './app-view-policy';

describe('getAppViewState', () => {
  test('keeps the live frontend open while its replacement builds', () => {
    expect(
      getAppViewState({
        status: 'building',
        deploymentRevision: 'revision-one',
        hasFrontend: true,
        runtimeSupported: true,
      }),
    ).toEqual({
      hasLiveDeployment: true,
      isCompatibilityBlocked: false,
      canOpen: true,
    });
  });

  test('does not open an app before its first deployment is activated', () => {
    expect(
      getAppViewState({
        status: 'building',
        deploymentRevision: null,
        hasFrontend: false,
        runtimeSupported: false,
      }),
    ).toEqual({
      hasLiveDeployment: false,
      isCompatibilityBlocked: false,
      canOpen: false,
    });
  });

  test('closes the iframe when the refreshed deployment has no frontend', () => {
    expect(
      getAppViewState({
        status: 'deployed',
        deploymentRevision: 'revision-two',
        hasFrontend: false,
        runtimeSupported: true,
      }),
    ).toEqual({
      hasLiveDeployment: true,
      isCompatibilityBlocked: false,
      canOpen: false,
    });
  });

  test('does not serve an archived frontend', () => {
    expect(
      getAppViewState({
        status: 'archived',
        deploymentRevision: 'revision-one',
        hasFrontend: true,
        runtimeSupported: true,
      }),
    ).toEqual({
      hasLiveDeployment: false,
      isCompatibilityBlocked: false,
      canOpen: false,
    });
  });

  test('blocks a live frontend below the minimum compatibility', () => {
    expect(
      getAppViewState({
        status: 'deployed',
        deploymentRevision: 'revision-one',
        hasFrontend: true,
        runtimeSupported: false,
      }),
    ).toEqual({
      hasLiveDeployment: true,
      isCompatibilityBlocked: true,
      canOpen: false,
    });
  });
});
