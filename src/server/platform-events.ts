/** Events broadcast by the Platform process to connected browser clients. */
export type PlatformEvent = {
  type: 'app.deployment.activated';
  appId: string;
  deploymentRevision: string;
};

export type PlatformEventSubscriber = (event: PlatformEvent) => void;

type PlatformEventsGlobal = typeof globalThis & {
  __hatchPlatformEventSubscribers__?: Set<PlatformEventSubscriber>;
};

function subscribers(): Set<PlatformEventSubscriber> {
  const global = globalThis as PlatformEventsGlobal;
  global.__hatchPlatformEventSubscribers__ ??=
    new Set<PlatformEventSubscriber>();
  return global.__hatchPlatformEventSubscribers__;
}

/**
 * Publish a transient Platform event to every subscriber in this process.
 *
 * Subscriber failures are isolated so a disconnected stream (or a future
 * faulty subscriber) can never turn a successful domain operation into a
 * failure. Events are deliberately not persisted; clients resync from the
 * database whenever their SSE connection is established.
 */
export function publishPlatformEvent(event: PlatformEvent): void {
  for (const subscriber of subscribers()) {
    try {
      subscriber(event);
    } catch (error) {
      console.error('Platform event subscriber failed.', error);
    }
  }
}

/** Subscribe to Platform events until the returned function is called. */
export function subscribePlatformEvents(
  subscriber: PlatformEventSubscriber,
): () => void {
  const currentSubscribers = subscribers();
  currentSubscribers.add(subscriber);
  return () => {
    currentSubscribers.delete(subscriber);
  };
}
