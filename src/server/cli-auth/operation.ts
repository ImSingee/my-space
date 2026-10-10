import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliScope } from '~auth/cli-policy';
import type { TX } from '~/db';
import type { CliPrincipal } from './credentials';

// Only the public API sets this context. Existing Cookie UI and trusted internal
// services retain their contracts; credential strings never enter service options.
const operations = new AsyncLocalStorage<{
  principal: CliPrincipal;
  scope: CliScope;
  resourceId?: string;
}>();
export function withCliOperation<T>(
  principal: CliPrincipal,
  scope: CliScope,
  resourceId: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return operations.run({ principal, scope, resourceId }, work);
}
export async function assertCliWrite(tx?: TX): Promise<void> {
  const operation = operations.getStore();
  if (!operation) return;
  const { authorizeCommit } = await import('./credentials');
  const check = (connection: TX) =>
    authorizeCommit(
      operation.principal,
      operation.scope,
      operation.resourceId,
      connection,
    );
  if (tx) await check(tx);
  else {
    const { db } = await import('~/db');
    await db.transaction(check);
  }
}
