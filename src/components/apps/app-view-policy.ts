import type { AppStatus } from '~/db/schema';

export function getAppViewState({
  status,
  deploymentRevision,
  hasFrontend,
  runtimeSupported,
}: {
  status: AppStatus;
  deploymentRevision: string | null;
  hasFrontend: boolean;
  runtimeSupported: boolean;
}) {
  const hasLiveDeployment =
    status !== 'archived' && deploymentRevision !== null;
  const isCompatibilityBlocked = hasLiveDeployment && !runtimeSupported;
  return {
    hasLiveDeployment,
    isCompatibilityBlocked,
    canOpen: hasLiveDeployment && hasFrontend && runtimeSupported,
  };
}
