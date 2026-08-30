import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';
import { useEventCallback } from '~hooks/use-latest-committed';

type PendingRevision = {
  appId: string;
  revision: string | null;
};

type DeploymentUpdateState = {
  appId: string;
  baselineRevision: string | null;
  pending: PendingRevision | null;
};

export type DeploymentRevisionReader = (
  appId: string,
) => Promise<string | null>;

/**
 * Tracks whether durable deployment state has moved beyond the route loader's
 * snapshot. A sequence fence prevents a slow reconnect check from overwriting
 * a newer event that arrived while the check was in flight.
 */
export function useAppDeploymentUpdate({
  appId,
  deploymentRevision,
  revisionReader,
}: {
  appId: string;
  deploymentRevision: string | null;
  revisionReader: DeploymentRevisionReader;
}) {
  const sequence = useRef(0);
  const [updateState, setUpdateState] = useState<DeploymentUpdateState>(() => ({
    appId,
    baselineRevision: deploymentRevision,
    pending: null,
  }));

  let currentState = updateState;
  if (
    updateState.appId !== appId ||
    updateState.baselineRevision !== deploymentRevision
  ) {
    currentState = {
      appId,
      baselineRevision: deploymentRevision,
      pending:
        updateState.pending?.appId === appId &&
        updateState.pending.revision !== deploymentRevision
          ? updateState.pending
          : null,
    };
    setUpdateState(currentState);
  }

  const applyRevision = useEventCallback(
    (nextAppId: string, revision: string | null) => {
      if (nextAppId !== appId) return;
      setUpdateState({
        appId,
        baselineRevision: deploymentRevision,
        pending:
          revision === deploymentRevision
            ? null
            : { appId: nextAppId, revision },
      });
    },
  );

  useLayoutEffect(() => {
    // Invalidate older resync responses as soon as a new loader baseline commits.
    sequence.current += 1;
  }, [appId, deploymentRevision]);

  usePlatformEvent('app.deployment.activated', (event) => {
    if (event.appId !== appId) return;
    sequence.current += 1;
    applyRevision(event.appId, event.deploymentRevision);
  });

  const resync = useEventCallback(() => {
    const snapshot = { appId, revisionReader };
    const requestSequence = ++sequence.current;
    void snapshot
      .revisionReader(snapshot.appId)
      .then((revision) => {
        if (sequence.current === requestSequence) {
          applyRevision(snapshot.appId, revision);
        }
      })
      // The EventSource will reconnect and issue another resync. Until then,
      // retain the last trustworthy event/loader state rather than guessing.
      .catch(() => undefined);
  });

  usePlatformResync(resync);

  useEffect(() => {
    // The shell-level EventSource can already be connected when this route
    // mounts. Reconcile once so an activation between the loader snapshot and
    // this hook's subscription cannot be lost waiting for a future reconnect.
    resync();
  }, [appId, resync]);

  const pendingRevision = currentState.pending?.revision ?? null;

  return {
    pendingRevision,
    updateAvailable: currentState.pending !== null,
  };
}
