import { describe, expect, test } from 'vitest';
import { getAppViewState } from './app-view-policy';

describe('getAppViewState', () => {
  test('keeps the live frontend open while its replacement builds', () => {
    expect(
      getAppViewState({
        status: 'building',
        deploymentRevision: 'revision-one',
        hasFrontend: true,
      }),
    ).toEqual({ hasLiveDeployment: true, canOpen: true });
  });

  test('does not open an app before its first deployment is activated', () => {
    expect(
      getAppViewState({
        status: 'building',
        deploymentRevision: null,
        hasFrontend: false,
      }),
    ).toEqual({ hasLiveDeployment: false, canOpen: false });
  });

  test('closes the iframe when the refreshed deployment has no frontend', () => {
    expect(
      getAppViewState({
        status: 'deployed',
        deploymentRevision: 'revision-two',
        hasFrontend: false,
      }),
    ).toEqual({ hasLiveDeployment: true, canOpen: false });
  });

  test('does not serve an archived frontend', () => {
    expect(
      getAppViewState({
        status: 'archived',
        deploymentRevision: 'revision-one',
        hasFrontend: true,
      }),
    ).toEqual({ hasLiveDeployment: false, canOpen: false });
  });
});
