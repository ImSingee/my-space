/** Data migration error contracts without database initialization. */
import { AppError } from '~server/errors';
export type DataMigrationStep = {
  description: string;
  sql: string;
  destructive: boolean;
};

export type DataMigrationPlan = {
  fromHash: string | null;
  toHash: string;
  steps: DataMigrationStep[];
  destructive: boolean;
  approvalToken: string;
};

export class DataMigrationApprovalRequired extends AppError {
  constructor(readonly plan: DataMigrationPlan) {
    super(
      'Data Table migration contains destructive changes and requires ' +
        'allow_destructive_data_migration=true with the matching preview ' +
        'token.\n' +
        plan.steps
          .filter((step) => step.destructive)
          .map((step) => `- ${step.description}`)
          .join('\n') +
        `\nApproval token: ${plan.approvalToken}` +
        '\nRetry with data_migration_approval_token set to this exact value.' +
        '\n\nGenerated migration SQL:\n' +
        plan.steps.map((step) => `${step.sql};`).join('\n'),
      409,
    );
    this.name = 'DataMigrationApprovalRequired';
  }
}
