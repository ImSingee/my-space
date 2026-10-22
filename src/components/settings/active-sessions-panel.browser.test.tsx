import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import {
  accountSessionsQueryOptions,
  type AccountSession,
} from '~queries/account-sessions';
import {
  listAccountSessions,
  revokeAccountSession,
} from '~server/account-sessions';
import { ActiveSessionsPanel } from './active-sessions-panel';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}));
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('~server/account-sessions', () => ({
  listAccountSessions: vi.fn<() => void>(),
  revokeAccountSession: vi.fn<() => void>(),
}));

const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
const DEVICE_FAILED = 'Could not sign out that device. Please try again.';

const list = vi.mocked(listAccountSessions);
const revoke = vi.mocked(revokeAccountSession);

let serverSessions: AccountSession[];
let navigations: string[];
const recordNavigation = (event: NavigateEvent) => {
  navigations.push(event.destination.url);
  event.preventDefault();
};

function session(
  id: string,
  hoursAgo: number,
  overrides: Partial<AccountSession> = {},
): AccountSession {
  const createdAt = new Date(Date.UTC(2026, 9, 12, 12) - hoursAgo * 3_600_000);
  return {
    id,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 7 * 86_400_000).toISOString(),
    ipAddress: `198.51.100.${hoursAgo}`,
    userAgent: WINDOWS_EDGE,
    isCurrent: false,
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<{ success: true }>((done) => {
    resolve = () => done({ success: true });
  });
  return { promise, resolve };
}

beforeEach(() => {
  // Reset queued one-off implementations too, not just recorded calls.
  vi.resetAllMocks();
  // The server lists newest first; the current session is not the newest.
  serverSessions = [
    session('session-edge', 1),
    session('session-current', 5, {
      userAgent: MAC_CHROME,
      ipAddress: '203.0.113.10',
      updatedAt: new Date(Date.UTC(2026, 9, 12, 11, 30)).toISOString(),
      isCurrent: true,
    }),
    session('session-phone', 30, { userAgent: IPHONE_SAFARI, ipAddress: null }),
  ];
  list.mockImplementation(async () => ({ items: [...serverSessions] }));
  revoke.mockImplementation(async (options) => {
    const { sessionId } = options.data;
    serverSessions = serverSessions.filter((item) => item.id !== sessionId);
    return { success: true as const };
  });
  navigations = [];
  navigation.addEventListener('navigate', recordNavigation);
});

afterEach(() => {
  navigation.removeEventListener('navigate', recordNavigation);
  vi.restoreAllMocks();
});

async function renderAccount() {
  const client = new QueryClient({
    // Mirrors the app router's global mutation error toast.
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) => {
        if (mutation.meta?.errorToast !== false) toast.error(error.message);
      },
    }),
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ModalsProvider>
          <ActiveSessionsPanel />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return Object.assign(screen, { client });
}

async function renderLoadedAccount() {
  const screen = await renderAccount();
  await expect.poll(() => rowLabels()).toHaveLength(serverSessions.length);
  return screen;
}

type Screen = Awaited<ReturnType<typeof renderAccount>>;

function sessionList() {
  return document.querySelector('ul[aria-label="Active sessions"]');
}

function rowLabels() {
  return [...(sessionList()?.querySelectorAll('li') ?? [])].map(
    (row) => row.querySelector('p')?.textContent,
  );
}

function rowSignOut(screen: Screen, label: string) {
  return screen.getByRole('button', {
    name: new RegExp(`^Sign out ${label},`),
  });
}

/** Answer the open confirmation and wait until it has fully closed. */
async function answer(screen: Screen, name: string) {
  const dialog = screen.getByRole('dialog');
  await dialog.getByRole('button', { name }).click();
  await expect.element(dialog).not.toBeInTheDocument();
}

test('lists the current session first without a sign-out control and signs out one confirmed session only', async () => {
  const screen = await renderLoadedAccount();

  expect(rowLabels()).toEqual([
    'Chrome on macOS',
    'Edge on Windows',
    'Safari on iOS',
  ]);
  const current = screen
    .getByRole('list', { name: 'Active sessions' })
    .getByRole('listitem')
    .first();
  await expect.element(current.getByText('Current session')).toBeVisible();
  await expect
    .element(current.getByText('203.0.113.10'))
    .not.toBeInTheDocument();
  await expect.element(current.getByRole('button')).not.toBeInTheDocument();
  // Sessions are signed out one at a time; there is no bulk entry point.
  await expect
    .element(screen.getByRole('button', { name: /other (devices|sessions)/i }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('IP address unavailable'))
    .not.toBeInTheDocument();
  expect(
    [...sessionList()!.querySelectorAll('time')].map((time) => time.dateTime),
  ).toEqual(
    ['session-current', 'session-edge', 'session-phone'].map(
      (id) => serverSessions.find((item) => item.id === id)!.updatedAt,
    ),
  );

  // Dismissing the confirmation sends nothing.
  await rowSignOut(screen, 'Safari on iOS').click();
  const dialog = screen.getByRole('dialog');
  await expect
    .element(dialog.getByText('Sign out Safari on iOS?'))
    .toBeVisible();
  await answer(screen, 'Cancel');
  expect(revoke).not.toHaveBeenCalled();

  const pending = deferred();
  revoke.mockImplementationOnce(async (options) => {
    await pending.promise;
    serverSessions = serverSessions.filter(
      (item) => item.id !== options.data.sessionId,
    );
    return { success: true as const };
  });
  await rowSignOut(screen, 'Safari on iOS').click();
  await answer(screen, 'Sign out session');
  await expect.element(rowSignOut(screen, 'Safari on iOS')).toBeDisabled();
  await expect.element(rowSignOut(screen, 'Edge on Windows')).toBeEnabled();
  rowSignOut(screen, 'Safari on iOS')
    .element()
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith({ data: { sessionId: 'session-phone' } });

  const listCalls = list.mock.calls.length;
  pending.resolve();
  await expect
    .poll(() => rowLabels())
    .toEqual(['Chrome on macOS', 'Edge on Windows']);
  await expect.poll(() => list.mock.calls.length).toBe(listCalls + 1);
  // The other session is untouched and can still be signed out on its own.
  await expect.element(rowSignOut(screen, 'Edge on Windows')).toBeEnabled();
  expect(revoke).toHaveBeenCalledOnce();
  expect(mocks.toastSuccess).toHaveBeenCalledWith('Device signed out');
  expect(mocks.toastError).not.toHaveBeenCalled();
  expect(navigations).toEqual([]);
});

test('failures keep the list, hide server errors, and can be retried', async () => {
  const serverError = new Error('relation "session" does not exist');
  list.mockRejectedValueOnce(serverError);
  const screen = await renderAccount();

  await expect
    .element(screen.getByText('Active sessions could not be loaded'))
    .toBeVisible();
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => rowLabels()).toHaveLength(3);

  revoke.mockRejectedValueOnce(serverError);
  await rowSignOut(screen, 'Safari on iOS').click();
  await answer(screen, 'Sign out session');
  await expect.poll(() => mocks.toastError).toHaveBeenCalledWith(DEVICE_FAILED);
  await expect.element(rowSignOut(screen, 'Safari on iOS')).toBeEnabled();
  expect(rowLabels()).toHaveLength(3);
  await rowSignOut(screen, 'Safari on iOS').click();
  await answer(screen, 'Sign out session');
  await expect
    .poll(() => rowLabels())
    .toEqual(['Chrome on macOS', 'Edge on Windows']);
  expect(revoke).toHaveBeenCalledTimes(2);

  expect(mocks.toastError).toHaveBeenCalledOnce();
  expect(document.body.textContent).not.toContain('relation "session"');
  expect(navigations).toEqual([]);

  // Account security metadata must not outlive the Account page.
  screen.unmount();
  await expect
    .poll(() =>
      screen.client.getQueryCache().find({
        queryKey: accountSessionsQueryOptions.queryKey,
      }),
    )
    .toBeUndefined();
});

/** Ancestors whose overflow would hide content that escapes their box. */
function clippingAncestors(element: Element) {
  const clips: Element[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowX !== 'visible') clips.push(node);
  }
  return clips;
}

test('narrow rows wrap session activity from the text column without clipping', async () => {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(320, 900);
  try {
    await renderLoadedAccount();
    await expect
      .poll(() => document.querySelectorAll('li time').length)
      .toBe(serverSessions.length);

    const rows = [...document.querySelectorAll('li time')].map((time) => {
      const metadata = time.closest('p')!;
      const range = document.createRange();
      range.selectNodeContents(metadata);
      return {
        metadata,
        // The device label marks where the row's text column starts.
        textStart: time
          .closest('li')!
          .querySelector('p')!
          .getBoundingClientRect().left,
        lines: [...range.getClientRects()],
      };
    });
    // Activity metadata must actually wrap for this check to mean anything.
    expect(
      rows.some(
        ({ lines }) =>
          new Set(lines.map((line) => Math.round(line.top))).size > 1,
      ),
    ).toBe(true);
    for (const { metadata, textStart, lines } of rows) {
      const clips = clippingAncestors(metadata).map((clip) =>
        clip.getBoundingClientRect(),
      );
      for (const line of lines) {
        expect(line.left).toBeGreaterThanOrEqual(textStart - 0.5);
        expect(line.right).toBeLessThanOrEqual(
          document.documentElement.clientWidth + 0.5,
        );
        for (const clip of clips) {
          expect(line.left).toBeGreaterThanOrEqual(clip.left - 0.5);
          expect(line.right).toBeLessThanOrEqual(clip.right + 0.5);
        }
      }
    }
  } finally {
    await page.viewport(previous.width, previous.height);
  }
});
