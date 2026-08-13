import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import type { PlatformEvent } from '~server/platform-events';
import {
  PlatformEventsProvider,
  usePlatformEvent,
  usePlatformResync,
} from './platform-events';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly close = vi.fn<() => void>();

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    FakeEventSource.instances.push(this);
  }

  emit(name: 'platform' | 'resync', data: object = {}) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

function installEventSource() {
  FakeEventSource.instances = [];
  vi.stubGlobal(
    'EventSource',
    FakeEventSource as unknown as typeof EventSource,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function SubscriptionProbe({ name }: { name: string }) {
  const [events, setEvents] = useState(0);
  const [resyncs, setResyncs] = useState(0);
  usePlatformEvent('app.deployment.activated', () => {
    setEvents((current) => current + 1);
  });
  usePlatformResync(() => {
    setResyncs((current) => current + 1);
  });
  return <output>{`${name}:${events}:${resyncs}`}</output>;
}

test('shares one named-event stream across subscribers and closes it', async () => {
  installEventSource();
  const screen = await render(
    <PlatformEventsProvider>
      <SubscriptionProbe name="first" />
      <SubscriptionProbe name="second" />
    </PlatformEventsProvider>,
  );

  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  expect(source?.url).toBe('/api/events');

  source?.emit('platform', {
    type: 'app.deployment.activated',
    appId: 'malformed-without-revision',
  });
  source?.emit('platform', {
    type: 'app.deployment.activated',
    appId: 'app-one',
    deploymentRevision: 'revision-two',
  } satisfies PlatformEvent);
  source?.emit('resync');

  await expect.element(screen.getByText('first:1:1')).toBeVisible();
  await expect.element(screen.getByText('second:1:1')).toBeVisible();

  screen.unmount();
  expect(source?.close).toHaveBeenCalledOnce();
});

function UpdateProbe({
  appId = 'app-one',
  initialRevision = 'revision-one',
  revisionReader = async () => initialRevision,
  refreshGate,
}: {
  appId?: string;
  initialRevision?: string | null;
  revisionReader?: (appId: string) => Promise<string | null>;
  refreshGate?: Promise<void>;
}) {
  const [baseline, setBaseline] = useState(initialRevision);
  const { pendingRevision, updateAvailable } = useAppDeploymentUpdate({
    appId,
    deploymentRevision: baseline,
    revisionReader,
  });

  return (
    <>
      <output data-testid="available">{String(updateAvailable)}</output>
      <output data-testid="pending">{pendingRevision ?? 'none'}</output>
      <button
        type="button"
        onClick={() => {
          if (refreshGate) {
            void refreshGate.then(() => setBaseline('revision-two'));
          } else {
            setBaseline('revision-two');
          }
        }}
      >
        Load revision two
      </button>
    </>
  );
}

function emitDeployment(
  source: FakeEventSource,
  appId: string,
  deploymentRevision: string,
) {
  source.emit('platform', {
    type: 'app.deployment.activated',
    appId,
    deploymentRevision,
  } satisfies PlatformEvent);
}

test('only marks a different revision for the canonical current app', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  emitDeployment(source, 'another-app', 'revision-two');
  emitDeployment(source, 'app-one', 'revision-one');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');

  authoritativeRevision = 'revision-two';
  emitDeployment(source, 'app-one', 'revision-two');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-two');

  await screen.getByRole('button', { name: 'Load revision two' }).click();
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');
});

test('mount reconciliation recovers a deployment missed before subscription', async () => {
  installEventSource();
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve('revision-one'),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe initialRevision={null} revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-one'));
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-one');
});

test('resync rechecks durable deployment state after reconnect', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  authoritativeRevision = 'revision-two';
  source.emit('resync');

  await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-two');
});

test('a slow reconciliation cannot replace a newer event', async () => {
  installEventSource();
  let resolveRevision: ((revision: string | null) => void) | undefined;
  const reader = vi.fn<() => Promise<string | null>>(
    () =>
      new Promise<string | null>((resolve) => {
        resolveRevision = resolve;
      }),
  );
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
  emitDeployment(source, 'app-one', 'revision-three');
  resolveRevision?.('revision-two');

  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-three');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
});

test('an update arriving during refresh remains pending', async () => {
  installEventSource();
  let authoritativeRevision = 'revision-one';
  const reader = vi.fn<(appId: string) => Promise<string>>(async () =>
    Promise.resolve(authoritativeRevision),
  );
  let completeRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    completeRefresh = resolve;
  });
  const screen = await render(
    <PlatformEventsProvider>
      <UpdateProbe refreshGate={refreshGate} revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = FakeEventSource.instances[0];
  if (!source) throw new Error('Expected the platform EventSource.');

  authoritativeRevision = 'revision-two';
  emitDeployment(source, 'app-one', 'revision-two');
  await screen.getByRole('button', { name: 'Load revision two' }).click();
  authoritativeRevision = 'revision-three';
  emitDeployment(source, 'app-one', 'revision-three');
  completeRefresh?.();

  await expect
    .element(screen.getByTestId('pending'))
    .toHaveTextContent('revision-three');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('true');
});

function SwitchingAppProbe({
  revisionReader,
}: {
  revisionReader: (appId: string) => Promise<string | null>;
}) {
  const [appId, setAppId] = useState('app-one');
  const { pendingRevision, updateAvailable } = useAppDeploymentUpdate({
    appId,
    deploymentRevision: 'revision-one',
    revisionReader,
  });
  return (
    <>
      <output data-testid="app-id">{appId}</output>
      <output data-testid="available">{String(updateAvailable)}</output>
      <output data-testid="pending">{pendingRevision ?? 'none'}</output>
      <button type="button" onClick={() => setAppId('app-two')}>
        Switch app
      </button>
    </>
  );
}

test('ignores a reconciliation response from the previously viewed app', async () => {
  installEventSource();
  let resolveFirst: ((revision: string | null) => void) | undefined;
  const reader = vi.fn<(appId: string) => Promise<string | null>>((appId) => {
    if (appId === 'app-one') {
      return new Promise<string | null>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve('revision-one');
  });
  const screen = await render(
    <PlatformEventsProvider>
      <SwitchingAppProbe revisionReader={reader} />
    </PlatformEventsProvider>,
  );
  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-one'));

  await screen.getByRole('button', { name: 'Switch app' }).click();
  await vi.waitFor(() => expect(reader).toHaveBeenCalledWith('app-two'));
  resolveFirst?.('revision-two');

  await expect
    .element(screen.getByTestId('app-id'))
    .toHaveTextContent('app-two');
  await expect
    .element(screen.getByTestId('available'))
    .toHaveTextContent('false');
  await expect.element(screen.getByTestId('pending')).toHaveTextContent('none');
});
