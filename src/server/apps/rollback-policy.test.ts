import { describe, expect, it } from 'vitest';
import {
  APP_DATABASES_ROLLBACK_BLOCKED_REASON,
  databaseRollbackBlockedReason,
  dataTableRollbackBlockedReason,
  deploymentRequiresDataTable,
  deploymentRequiresDatabase,
  deploymentRollbackBlockedReason,
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

  it('recognizes only an explicitly enabled Data Table capability', () => {
    expect(
      deploymentRequiresDataTable({ capabilities: { dataTable: true } }),
    ).toBe(true);
    expect(
      deploymentRequiresDataTable({ capabilities: { dataTable: false } }),
    ).toBe(false);
    expect(deploymentRequiresDataTable({ capabilities: {} })).toBe(false);
    expect(deploymentRequiresDataTable(null)).toBe(false);
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

  it('blocks only Data Table-dependent deployments with no registration', () => {
    const manifest = { capabilities: { dataTable: true } };

    expect(dataTableRollbackBlockedReason(null, null, manifest)).toContain(
      'Data Table database was permanently deleted',
    );
    expect(
      dataTableRollbackBlockedReason(
        'hatch_data_example',
        'encrypted-password',
        manifest,
      ),
    ).toBeNull();
    expect(
      dataTableRollbackBlockedReason(null, null, {
        capabilities: { dataTable: false },
      }),
    ).toBeNull();
    expect(
      dataTableRollbackBlockedReason('hatch_data_example', null, manifest),
    ).toContain('Data Table database was permanently deleted');
  });

  it('combines missing resources into one rollback reason', () => {
    expect(
      deploymentRollbackBlockedReason(
        {
          dbName: null,
          dataDbName: null,
          dataDbPasswordCiphertext: null,
        },
        { capabilities: { database: true, dataTable: true } },
      ),
    ).toBe(APP_DATABASES_ROLLBACK_BLOCKED_REASON);
    expect(
      deploymentRollbackBlockedReason(
        {
          dbName: 'app_example',
          dataDbName: 'hatch_data_example',
          dataDbPasswordCiphertext: 'encrypted-password',
        },
        { capabilities: { database: true, dataTable: true } },
      ),
    ).toBeNull();
  });
});
