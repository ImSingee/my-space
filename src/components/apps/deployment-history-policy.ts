export type RollbackResult = {
  version: number;
  dataSchemaMismatch: boolean;
};

export function rollbackNotification(result: RollbackResult): {
  tone: 'success' | 'warning';
  message: string;
} {
  if (result.dataSchemaMismatch) {
    return {
      tone: 'warning',
      message:
        `Restored v${result.version}. The managed Data Table schema was not ` +
        'rolled back and may be incompatible with this code version.',
    };
  }
  return { tone: 'success', message: `Restored v${result.version}` };
}

export function requiresDataSchemaConfirmation(
  deployment: { dataSchemaMismatch: boolean } | undefined,
): boolean {
  return deployment?.dataSchemaMismatch === true;
}
