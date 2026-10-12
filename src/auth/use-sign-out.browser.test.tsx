import { MantineProvider } from '@mantine/core';
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { UserMenu } from '~components/app-shell/sidebar/user-menu';
import { useSignOut } from './use-sign-out';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn<(message: string) => void>(),
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
// Keep the real SDK's response parsing; forward transport to the per-test
// fetch spy instead of the fetch captured at module initialization.
vi.mock('~auth/client', async () => {
  const { createAuthClient } = await import('better-auth/react');
  const client = createAuthClient({
    fetchOptions: {
      customFetchImpl: (input, init) => window.fetch(input, init),
    },
  });
  return {
    authClient: {
      signOut: client.signOut,
      useSession: () => ({
        data: { user: { name: 'Test owner', email: 'owner@example.test' } },
      }),
    },
  };
});

const LOGIN = new URL('/login', window.location.origin).href;
const FAILED = 'Could not sign out. Please try again.';

// `location.replace` cannot be stubbed, so record and cancel the real
// document navigation it starts.
let navigations: { url: string; type: NavigationType }[];
const recordNavigation = (event: NavigateEvent) => {
  navigations.push({ url: event.destination.url, type: event.navigationType });
  event.preventDefault();
};

beforeEach(() => {
  vi.clearAllMocks();
  navigations = [];
  navigation.addEventListener('navigate', recordNavigation);
});
afterEach(() => {
  navigation.removeEventListener('navigate', recordNavigation);
  vi.restoreAllMocks();
});

/** A second exit control, standing in for any other `useSignOut` consumer. */
function OtherExit() {
  const { signOut, leaving } = useSignOut();
  return (
    <button type="button" disabled={leaving} onClick={signOut}>
      Other exit
    </button>
  );
}

async function renderSidebar({ withOtherExit = false } = {}) {
  const client = new QueryClient({
    // Mirrors the app router's global mutation error toast.
    mutationCache: new MutationCache({
      onError: (error, _variables, _result, mutation) => {
        if (mutation.meta?.errorToast !== false) toast.error(error.message);
      },
    }),
  });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          {withOtherExit && <OtherExit />}
          <UserMenu />
        </>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  const menuItem = screen.getByRole('menuitem', { name: 'Sign out' });
  const openMenu = async () => {
    if (!menuItem.query()) {
      await screen.getByRole('button', { name: 'Account menu' }).click();
    }
    await expect.element(menuItem).toBeVisible();
    return menuItem;
  };
  return Object.assign(screen, { openMenu });
}

function signOutRequests() {
  return vi
    .mocked(window.fetch)
    .mock.calls.filter(
      ([url, init]) =>
        new URL(String(url), window.location.origin).pathname ===
          '/api/auth/sign-out' && init?.method === 'POST',
    );
}

test('the sidebar signs out once, stays disabled, and replaces the page with login', async () => {
  let respond!: (value: Response) => void;
  vi.spyOn(window, 'fetch').mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const screen = await renderSidebar();

  await (await screen.openMenu()).click();
  const item = await screen.openMenu();
  await expect.element(item).toBeDisabled();
  item.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(signOutRequests()).toHaveLength(1);
  expect(navigations).toEqual([]);

  respond(Response.json({ success: true }));
  await expect
    .poll(() => navigations)
    .toEqual([{ url: LOGIN, type: 'replace' }]);
  await expect.element(item).toBeDisabled();
  expect(signOutRequests()).toHaveLength(1);
  expect(mocks.toastError).not.toHaveBeenCalled();
});

test('failed sign-outs keep the page, report an error, and can be retried', async () => {
  vi.spyOn(window, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ message: 'Internal Server Error' }, { status: 500 }),
    )
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(Response.json({ success: true }));
  const screen = await renderSidebar();

  await (await screen.openMenu()).click();
  await expect.poll(() => mocks.toastError).toHaveBeenCalledWith(FAILED);
  await expect.element(await screen.openMenu()).toBeEnabled();
  expect(navigations).toEqual([]);

  await (await screen.openMenu()).click();
  await expect.poll(() => mocks.toastError).toHaveBeenCalledTimes(2);
  expect(mocks.toastError).toHaveBeenLastCalledWith(FAILED);
  await expect.element(await screen.openMenu()).toBeEnabled();
  expect(navigations).toEqual([]);

  await (await screen.openMenu()).click();
  await expect
    .poll(() => navigations)
    .toEqual([{ url: LOGIN, type: 'replace' }]);
  expect(signOutRequests()).toHaveLength(3);
  expect(mocks.toastError).toHaveBeenCalledTimes(2);
});

test('every exit control shares one pending request and its outcome', async () => {
  let respond!: (value: Response) => void;
  vi.spyOn(window, 'fetch')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValueOnce(Response.json({ success: true }));
  const screen = await renderSidebar({ withOtherExit: true });
  const otherExit = screen.getByRole('button', { name: 'Other exit' });

  await otherExit.click();
  const item = await screen.openMenu();
  await expect.element(item).toBeDisabled();
  item.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(signOutRequests()).toHaveLength(1);

  respond(Response.json({ message: 'Internal Server Error' }, { status: 500 }));
  await expect.poll(() => mocks.toastError).toHaveBeenCalledOnce();
  expect(navigations).toEqual([]);
  await expect.element(otherExit).toBeEnabled();
  await expect.element(item).toBeEnabled();

  await item.click();
  await expect
    .poll(() => navigations)
    .toEqual([{ url: LOGIN, type: 'replace' }]);
  expect(signOutRequests()).toHaveLength(2);
  expect(mocks.toastError).toHaveBeenCalledOnce();
});
