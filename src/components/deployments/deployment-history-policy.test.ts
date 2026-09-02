import { describe, expect, it } from 'vitest';
import { requiresAgentRollback } from './deployment-history-policy';

describe('requiresAgentRollback', () => {
  it('routes only restorable deployments outside the supported range', () => {
    expect(
      requiresAgentRollback({
        canRollback: true,
        compatibility: { isSupported: false },
      }),
    ).toBe(true);
    expect(
      requiresAgentRollback({
        canRollback: true,
        compatibility: { isSupported: true },
      }),
    ).toBe(false);
    expect(
      requiresAgentRollback({
        canRollback: false,
        compatibility: { isSupported: false },
      }),
    ).toBe(false);
    expect(requiresAgentRollback(undefined)).toBe(false);
  });
});
