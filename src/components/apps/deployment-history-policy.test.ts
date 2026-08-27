import { describe, expect, it } from 'vitest';
import {
  requiresAgentRollback,
  requiresDataSchemaConfirmation,
  rollbackNotification,
} from './deployment-history-policy';

describe('app rollback notifications', () => {
  it('surfaces an authoritative post-rollback schema mismatch as a warning', () => {
    expect(
      rollbackNotification({ version: 3, dataSchemaMismatch: true }),
    ).toEqual({
      tone: 'warning',
      message:
        'Restored v3. The managed Data Table schema was not rolled back and ' +
        'may be incompatible with this code version.',
    });
  });

  it('uses the normal success notification when schemas match', () => {
    expect(
      rollbackNotification({ version: 3, dataSchemaMismatch: false }),
    ).toEqual({ tone: 'success', message: 'Restored v3' });
  });

  it('retains pre-confirmation for a deployment known to have a mismatch', () => {
    expect(requiresDataSchemaConfirmation({ dataSchemaMismatch: true })).toBe(
      true,
    );
    expect(requiresDataSchemaConfirmation({ dataSchemaMismatch: false })).toBe(
      false,
    );
    expect(requiresDataSchemaConfirmation(undefined)).toBe(false);
  });
});

describe('requiresAgentRollback', () => {
  it('routes rollback below the minimum through Agent', () => {
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
  });
});
