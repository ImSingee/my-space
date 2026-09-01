import { describe, expect, it } from 'vitest';
import {
  LATEST_WORKFLOW_COMPATIBILITY_VERSION,
  MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION,
  resolveWorkflowDeployCompatibilityVersion,
  workflowCompatibility,
  workflowCompatibilityRollbackMessage,
  workflowCompatibilityRuntimeMessage,
} from './workflow-compatibility';

describe('Workflow compatibility', () => {
  it('starts with latest and minimum compatibility v1', () => {
    expect(LATEST_WORKFLOW_COMPATIBILITY_VERSION).toBe(1);
    expect(MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION).toBe(1);
    expect(resolveWorkflowDeployCompatibilityVersion(1)).toBe(1);
  });

  it('rejects source compatibility below the platform minimum', () => {
    expect(() => resolveWorkflowDeployCompatibilityVersion(0)).toThrow(
      /manifest\.json compatibilityVersion.*below.*minimum/,
    );
  });

  it('rejects source compatibility newer than the platform', () => {
    expect(() => resolveWorkflowDeployCompatibilityVersion(2)).toThrow(
      /manifest\.json compatibilityVersion.*newer.*latest supported/,
    );
  });

  it('builds supported and below-minimum read models without a default', () => {
    expect(workflowCompatibility(1)).toEqual({
      version: 1,
      latestVersion: 1,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    });
    expect(workflowCompatibility(0)).toMatchObject({
      version: 0,
      isSupported: false,
      isLatest: false,
    });
  });

  it('marks versions newer than the platform latest as unsupported', () => {
    const compatibility = workflowCompatibility(
      LATEST_WORKFLOW_COMPATIBILITY_VERSION + 1,
    );

    expect(compatibility).toMatchObject({
      version: LATEST_WORKFLOW_COMPATIBILITY_VERSION + 1,
      isSupported: false,
      isLatest: false,
    });
    expect(workflowCompatibilityRuntimeMessage(compatibility)).toMatch(
      new RegExp(
        `newer than this platform's latest supported v${LATEST_WORKFLOW_COMPATIBILITY_VERSION}.*Update the platform`,
      ),
    );
    expect(workflowCompatibilityRollbackMessage(compatibility)).toMatch(
      new RegExp(
        `newer than this platform's latest supported v${LATEST_WORKFLOW_COMPATIBILITY_VERSION}.*Update the platform`,
      ),
    );
  });
});
