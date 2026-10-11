import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import {
  MutationCache,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { ApiKeySummary } from '~auth/api-key-contract';
import { ApiKeysPanel } from './api-keys-panel';

const SECRET = 'hatch_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const DAY = 86_400;

const mocks = vi.hoisted(() => ({
  copy: vi.fn<(text: string) => Promise<boolean>>(async () => true),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock('copy-to-clipboard', () => ({ default: mocks.copy }));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

type Route = 'list' | 'create' | 'revoke';
type Reply = (body: unknown) => Response | Promise<Response>;

let serverKeys: ApiKeySummary[];
let replies: Partial<Record<Route, Reply>>;
let calls: { route: Route; body: unknown }[];

const ROUTES: Record<string, Route> = {
  'GET /api/settings/api-keys': 'list',
  'POST /api/settings/api-keys': 'create',
  'POST /api/settings/api-keys/revoke': 'revoke',
};

const defaultReplies: Record<Route, Reply> = {
  list: () => Response.json({ keys: serverKeys }),
  create: (body) => {
    const { name, expiresIn } = body as {
      name: string;
      expiresIn: number | null;
    };
    const apiKey = summary({
      id: `key-${serverKeys.length + 1}`,
      name,
      expiresAt:
        expiresIn === null
          ? null
          : new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
    serverKeys = [...serverKeys, apiKey];
    return Response.json({ apiKey, key: SECRET });
  },
  revoke: (body) => {
    const { id } = body as { id: string };
    serverKeys = serverKeys.filter((key) => key.id !== id);
    return Response.json({ success: true });
  },
};

function summary(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: 'key-1',
    name: 'Laptop CLI',
    prefix: 'hatch_',
    start: SECRET.slice(0, 12),
    createdAt: new Date(Date.now() - 3 * DAY * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY * 1000).toISOString(),
    lastRequest: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copy.mockResolvedValue(true);
  serverKeys = [];
  replies = {};
  calls = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const route = ROUTES[`${init?.method ?? 'GET'} ${url.pathname}`];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, body });
    return (replies[route] ?? defaultReplies[route])(body);
  });
});

afterEach(() => vi.restoreAllMocks());

async function renderPanel(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    // Mirrors the app router's global mutation error toast.
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) => {
        if (mutation.meta?.errorToast !== false) toast.error(error.message);
      },
    }),
  }),
) {
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ModalsProvider>
          <ApiKeysPanel />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return Object.assign(screen, { client });
}

function callsTo(route: Route) {
  return calls.filter((call) => call.route === route);
}

function secretInDocument() {
  return (
    document.body.innerHTML.includes(SECRET) ||
    [...document.querySelectorAll('input')].some((input) =>
      input.value.includes(SECRET),
    )
  );
}

async function chooseExpiration(
  screen: Awaited<ReturnType<typeof renderPanel>>,
  label: string,
) {
  await screen.getByRole('combobox', { name: 'Expiration' }).click();
  await screen.getByRole('option', { name: label }).click();
}

test('reveals a new key once and keeps the secret out of caches, storage, and the page after closing', async () => {
  const screen = await renderPanel();
  await expect.element(screen.getByText('No API keys yet')).toBeVisible();

  await screen.getByRole('button', { name: 'Create API key' }).click();
  await screen.getByRole('textbox', { name: 'Name' }).fill('  Laptop CLI  ');
  await chooseExpiration(screen, '90 days');
  await screen.getByRole('button', { name: 'Create key' }).click();

  const secretField = screen.getByRole('textbox', {
    name: 'API key for Laptop CLI',
  });
  await expect.element(secretField).toHaveValue(SECRET);
  expect(callsTo('create').map((call) => call.body)).toEqual([
    { name: 'Laptop CLI', expiresIn: 90 * DAY },
  ]);

  // Only deliberate actions may dismiss the one-time reveal.
  await userEvent.keyboard('{Escape}');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.element(secretField).toHaveValue(SECRET);

  await screen.getByRole('button', { name: 'Copy key' }).click();
  expect(mocks.copy).toHaveBeenCalledWith(SECRET);
  await expect
    .poll(() => mocks.toastSuccess)
    .toHaveBeenCalledWith('API key copied');

  const cached = JSON.stringify([
    screen.client
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    screen.client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  ]);
  expect(cached).not.toContain(SECRET);
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
    SECRET,
  );
  expect(window.location.href).not.toContain(SECRET);

  await screen.getByRole('button', { name: 'Done' }).click();
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
  expect(secretInDocument()).toBe(false);

  // The list shows metadata and the masked identifier only.
  const list = screen.getByRole('list', { name: 'API keys' });
  await expect.element(list.getByText('Laptop CLI')).toBeVisible();
  await expect.element(list.getByText('hatch_AbCdEf…')).toBeVisible();
  expect(secretInDocument()).toBe(false);

  // Reopening starts a fresh form instead of restoring the revealed key.
  await screen.getByRole('button', { name: 'Create API key' }).click();
  await expect
    .element(screen.getByRole('textbox', { name: 'Name' }))
    .toHaveValue('');
  expect(secretInDocument()).toBe(false);
});

test('sends one creation request at a time and keeps failures inline with the form intact', async () => {
  let respond!: (response: Response) => void;
  replies.create = () => new Promise((resolve) => (respond = resolve));
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'Create API key' }).click();

  // A blank name never reaches the server.
  await screen.getByRole('button', { name: 'Create key' }).click();
  await expect
    .element(screen.getByText('Enter a name for this key'))
    .toBeVisible();
  expect(callsTo('create')).toHaveLength(0);

  const nameField = screen.getByRole('textbox', { name: 'Name' });
  await nameField.fill('Deploy script');
  const submit = screen.getByRole('button', { name: 'Create key' });
  await submit.click();
  submit.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => callsTo('create')).toHaveLength(1);

  // Nothing can dismiss the dialog while the request is in flight.
  await expect
    .element(screen.getByRole('button', { name: 'Close' }))
    .toBeDisabled();
  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByRole('dialog')).toBeVisible();

  respond(new Response(null, { status: 500 }));
  await expect
    .element(screen.getByText('Creation could not be confirmed'))
    .toBeVisible();
  expect(mocks.toastError).not.toHaveBeenCalled();
  await expect.element(nameField).toHaveValue('Deploy script');

  replies.create = defaultReplies.create;
  await chooseExpiration(screen, 'No expiration');
  await screen.getByRole('button', { name: 'Create key' }).click();
  await expect
    .element(screen.getByRole('textbox', { name: 'API key for Deploy script' }))
    .toHaveValue(SECRET);
  expect(callsTo('create').map((call) => call.body)).toEqual([
    { name: 'Deploy script', expiresIn: 30 * DAY },
    { name: 'Deploy script', expiresIn: null },
  ]);
});

test('revokes a key only after confirmation and follows the server response', async () => {
  serverKeys = [
    summary({
      lastRequest: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    }),
    summary({
      id: 'key-2',
      name: 'Old script',
      start: 'hatch_ZyXwVu',
      expiresAt: new Date(Date.now() - DAY * 1000).toISOString(),
    }),
  ];
  const screen = await renderPanel();
  const list = screen.getByRole('list', { name: 'API keys' });
  await expect
    .element(list.getByText('Expired', { exact: true }))
    .toBeVisible();

  await screen.getByRole('button', { name: 'Revoke Laptop CLI' }).click();
  await screen.getByRole('button', { name: 'Cancel' }).click();
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
  expect(callsTo('revoke')).toHaveLength(0);

  await screen.getByRole('button', { name: 'Revoke Laptop CLI' }).click();
  await screen.getByRole('button', { name: 'Revoke key' }).click();
  await expect.element(list.getByText('Laptop CLI')).not.toBeInTheDocument();
  expect(callsTo('revoke').map((call) => call.body)).toEqual([{ id: 'key-1' }]);
  expect(mocks.toastSuccess).toHaveBeenCalledWith('API key revoked');

  // A failed revoke keeps the key listed, reports the error, and refetches.
  replies.revoke = () => new Response(null, { status: 500 });
  const listsBefore = callsTo('list').length;
  await screen.getByRole('button', { name: 'Revoke Old script' }).click();
  await screen.getByRole('button', { name: 'Revoke key' }).click();
  await expect.poll(() => mocks.toastError).toHaveBeenCalledOnce();
  await expect.poll(() => callsTo('list').length).toBeGreaterThan(listsBefore);
  await expect.element(list.getByText('Old script')).toBeVisible();
});

test('recovers from a failed list load with retry', async () => {
  replies.list = () => new Response(null, { status: 500 });
  const screen = await renderPanel();
  await expect
    .element(screen.getByText('API keys could not be loaded'))
    .toBeVisible();

  serverKeys = [summary()];
  replies.list = defaultReplies.list;
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect
    .element(
      screen.getByRole('list', { name: 'API keys' }).getByText('Laptop CLI'),
    )
    .toBeVisible();
});

test('offline credential actions fail immediately and never replay on reconnect', async () => {
  serverKeys = [summary()];
  const screen = await renderPanel();
  await expect
    .element(screen.getByRole('button', { name: 'Revoke Laptop CLI' }))
    .toBeVisible();
  replies.create = replies.revoke = () => {
    throw new TypeError('Offline');
  };
  onlineManager.setOnline(false);
  try {
    await screen.getByRole('button', { name: 'Create API key' }).click();
    await screen.getByRole('textbox', { name: 'Name' }).fill('Offline script');
    await screen.getByRole('button', { name: 'Create key' }).click();
    await expect
      .element(screen.getByText('Creation could not be confirmed'))
      .toBeVisible();
    expect(callsTo('create')).toHaveLength(1);
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await screen.getByRole('button', { name: 'Revoke Laptop CLI' }).click();
    await screen
      .getByRole('button', { name: 'Revoke key', exact: true })
      .click();
    await expect.poll(() => mocks.toastError).toHaveBeenCalledWith('Offline');
    expect(callsTo('revoke')).toHaveLength(1);
    expect(
      screen.client
        .getMutationCache()
        .getAll()
        .some((mutation) => mutation.state.isPaused),
    ).toBe(false);
  } finally {
    onlineManager.setOnline(true);
  }
  await expect
    .element(screen.getByRole('button', { name: 'Revoke Laptop CLI' }))
    .toBeVisible();
  expect(callsTo('create')).toHaveLength(1);
  expect(callsTo('revoke')).toHaveLength(1);
});

test('copy failure keeps the one-time secret available for manual recovery', async () => {
  mocks.copy.mockResolvedValue(false);
  const screen = await renderPanel();
  await screen.getByRole('button', { name: 'Create API key' }).click();
  await screen.getByRole('textbox', { name: 'Name' }).fill('Recovery script');
  await screen.getByRole('button', { name: 'Create key' }).click();
  await screen.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect.poll(() => mocks.toastError).toHaveBeenCalled();
  await expect
    .element(
      screen.getByRole('textbox', { name: 'API key for Recovery script' }),
    )
    .toHaveValue(SECRET);
  expect(mocks.toastSuccess).not.toHaveBeenCalledWith('API key copied');
});

test('leaving Security cancels old account reads and discards metadata before another login', async () => {
  let respond!: (response: Response) => void;
  replies.list = () => new Promise((resolve) => (respond = resolve));
  const first = await renderPanel();
  await expect.poll(() => callsTo('list')).toHaveLength(1);
  const signal = vi.mocked(window.fetch).mock.calls[0]?.[1]?.signal;
  expect(signal).toBeDefined();
  await first.unmount();
  expect(signal?.aborted).toBe(true);
  await expect
    .poll(() => first.client.getQueryCache().getAll())
    .toHaveLength(0);
  replies.list = () => Response.json({ keys: [] });
  const second = await renderPanel(first.client);
  await expect.element(second.getByText('No API keys yet')).toBeVisible();
  respond(Response.json({ keys: [summary({ name: 'Private automation' })] }));
  await expect
    .element(second.getByText('Private automation'))
    .not.toBeInTheDocument();
  expect(first.client.getQueryData(['auth', 'api-keys'])).toEqual([]);
});
