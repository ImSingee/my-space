import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { PlatformEvent } from '~server/platform-events';

type PlatformEventType = PlatformEvent['type'];
type PlatformEventFor<TType extends PlatformEventType> = Extract<
  PlatformEvent,
  { type: TType }
>;
type PlatformEventListener = (event: PlatformEvent) => void;
type ResyncListener = () => void;

type PlatformEventsContextValue = {
  subscribe: (listener: PlatformEventListener) => () => void;
  subscribeResync: (listener: ResyncListener) => () => void;
};

const PlatformEventsContext = createContext<PlatformEventsContextValue | null>(
  null,
);

function parsePlatformEvent(message: MessageEvent<string>) {
  try {
    const value: unknown = JSON.parse(message.data);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('type' in value) ||
      value.type !== 'app.deployment.activated' ||
      !('appId' in value) ||
      typeof value.appId !== 'string' ||
      !('deploymentRevision' in value) ||
      typeof value.deploymentRevision !== 'string'
    ) {
      return null;
    }
    return value as PlatformEvent;
  } catch {
    return null;
  }
}

/** Owns the authenticated app shell's single platform-wide SSE connection. */
export function PlatformEventsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const listeners = useRef(new Set<PlatformEventListener>());
  const resyncListeners = useRef(new Set<ResyncListener>());
  const context = useMemo<PlatformEventsContextValue>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      subscribeResync(listener) {
        resyncListeners.current.add(listener);
        return () => resyncListeners.current.delete(listener);
      },
    }),
    [],
  );

  useEffect(() => {
    const source = new EventSource('/api/events');
    const onPlatformEvent = (rawEvent: Event) => {
      const event = parsePlatformEvent(rawEvent as MessageEvent<string>);
      if (!event) return;
      for (const listener of listeners.current) listener(event);
    };
    const onResync = () => {
      for (const listener of resyncListeners.current) listener();
    };

    source.addEventListener('platform', onPlatformEvent);
    source.addEventListener('resync', onResync);

    return () => {
      source.removeEventListener('platform', onPlatformEvent);
      source.removeEventListener('resync', onResync);
      source.close();
    };
  }, []);

  return (
    <PlatformEventsContext.Provider value={context}>
      {children}
    </PlatformEventsContext.Provider>
  );
}

function usePlatformEventsContext() {
  const context = useContext(PlatformEventsContext);
  if (!context) {
    throw new Error(
      'Platform event hooks must be used within PlatformEventsProvider.',
    );
  }
  return context;
}

/** Subscribe to one domain event type without re-rendering unrelated consumers. */
export function usePlatformEvent<TType extends PlatformEventType>(
  type: TType,
  listener: (event: PlatformEventFor<TType>) => void,
) {
  const { subscribe } = usePlatformEventsContext();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === type) {
          listenerRef.current(event as PlatformEventFor<TType>);
        }
      }),
    [subscribe, type],
  );
}

/** Re-read durable state after the SSE stream connects or reconnects. */
export function usePlatformResync(listener: ResyncListener) {
  const { subscribeResync } = usePlatformEventsContext();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(
    () => subscribeResync(() => listenerRef.current()),
    [subscribeResync],
  );
}
