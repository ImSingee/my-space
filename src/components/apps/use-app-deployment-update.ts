import { useCallback, useEffect, useRef, useState } from 'react';
import {
  usePlatformEvent,
  usePlatformResync,
} from '~components/system/platform-events';

type PendingRevision = {
  appId: string;
  revision: string | null;
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
  const currentApp = useRef({ appId, deploymentRevision, revisionReader });
  currentApp.current = { appId, deploymentRevision, revisionReader };
  const sequence = useRef(0);
  const [pending, setPending] = useState<PendingRevision | null>(null);

  const applyRevision = useCallback(
    (nextAppId: string, revision: string | null) => {
      const baseline = currentApp.current;
      if (nextAppId !== baseline.appId) return;
      setPending(
        revision === baseline.deploymentRevision
          ? null
          : { appId: nextAppId, revision },
      );
    },
    [],
  );

  useEffect(() => {
    // A loader refresh or route change makes any older resync response stale.
    sequence.current += 1;
    setPending((current) => {
      if (current?.appId !== appId) return null;
      return current.revision === deploymentRevision ? null : current;
    });
  }, [appId, deploymentRevision]);

  usePlatformEvent('app.deployment.activated', (event) => {
    if (event.appId !== currentApp.current.appId) return;
    sequence.current += 1;
    applyRevision(event.appId, event.deploymentRevision);
  });

  const resync = useCallback(() => {
    const snapshot = currentApp.current;
    const requestSequence = ++sequence.current;
    void snapshot
      .revisionReader(snapshot.appId)
      .then((revision) => {
        if (
          sequence.current === requestSequence &&
          currentApp.current.appId === snapshot.appId
        ) {
          applyRevision(snapshot.appId, revision);
        }
      })
      // The EventSource will reconnect and issue another resync. Until then,
      // retain the last trustworthy event/loader state rather than guessing.
      .catch(() => undefined);
  }, [applyRevision]);

  usePlatformResync(resync);

  useEffect(() => {
    // The shell-level EventSource can already be connected when this route
    // mounts. Reconcile once so an activation between the loader snapshot and
    // this hook's subscription cannot be lost waiting for a future reconnect.
    resync();
  }, [appId, resync]);

  const pendingRevision =
    pending?.appId === appId && pending.revision !== deploymentRevision
      ? pending.revision
      : null;

  return {
    pendingRevision,
    updateAvailable:
      pending?.appId === appId && pending.revision !== deploymentRevision,
  };
}
