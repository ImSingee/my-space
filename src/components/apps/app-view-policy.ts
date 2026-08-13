import type { AppStatus } from '~/db/schema';

export function getAppViewState({
  status,
  deploymentRevision,
  hasFrontend,
}: {
  status: AppStatus;
  deploymentRevision: string | null;
  hasFrontend: boolean;
}) {
  const hasLiveDeployment =
    status !== 'archived' && deploymentRevision !== null;
  return {
    hasLiveDeployment,
    canOpen: hasLiveDeployment && hasFrontend,
  };
}
