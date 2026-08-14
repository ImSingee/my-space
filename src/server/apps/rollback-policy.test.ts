import { describe, expect, it } from 'vitest';
import {
  databaseRollbackBlockedReason,
  deploymentRequiresDatabase,
} from './rollback-policy';

describe('database rollback policy', () => {
  it('recognizes only an explicitly enabled database capability', () => {
    expect(
      deploymentRequiresDatabase({ capabilities: { database: true } }),
    ).toBe(true);
    expect(
      deploymentRequiresDatabase({ capabilities: { database: false } }),
    ).toBe(false);
    expect(deploymentRequiresDatabase({ capabilities: {} })).toBe(false);
    expect(deploymentRequiresDatabase(null)).toBe(false);
  });

  it('blocks only database-dependent deployments with no registration', () => {
    const manifest = { capabilities: { database: true } };

    expect(databaseRollbackBlockedReason(null, manifest)).toContain(
      'database was permanently deleted',
    );
    expect(databaseRollbackBlockedReason('app_example', manifest)).toBeNull();
    expect(
      databaseRollbackBlockedReason(null, {
        capabilities: { database: false },
      }),
    ).toBeNull();
  });
});
