import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useSurfaceHandoff } from '../../../mobile/src/state/use-surface-handoff';

const origin = 'https://hatch.example';

function Surface({
  api,
  focused,
  showing,
}: {
  api: Parameters<typeof useSurfaceHandoff>[0]['api'];
  focused: boolean;
  showing: string;
}) {
  const handoff = useSurfaceHandoff({ api, origin, focused });
  return (
    <output aria-label={showing}>
      {handoff.data?.ticket ?? (handoff.isFetching ? 'signing in' : 'waiting')}
    </output>
  );
}

/** The dashboard body: a surface exists only while there is a dashboard. */
function Dashboard({
  client,
  api,
  focused,
  dashboard,
  attempt = 0,
}: {
  client: QueryClient;
  api: Parameters<typeof useSurfaceHandoff>[0]['api'];
  focused: boolean;
  dashboard: string | null;
  attempt?: number;
}) {
  return (
    <QueryClientProvider client={client}>
      {dashboard ? (
        <Surface
          key={attempt}
          api={api}
          focused={focused}
          showing={dashboard}
        />
      ) : (
        <p>No dashboards yet</p>
      )}
    </QueryClientProvider>
  );
}

test('each dashboard surface signs in with its own ticket, claimed only on screen', async () => {
  const client = new QueryClient();
  let issued = 0;
  const createHandoff = vi.fn<
    () => Promise<{
      url: string;
      ticket: string;
      expiresAt: string;
      completionUrl: string;
    }>
  >(async () => {
    issued += 1;
    return {
      url: `${origin}/api/auth/handoffs/consume`,
      ticket: `ticket-${issued}`,
      expiresAt: '2099-01-01T00:00:00Z',
      completionUrl: `${origin}/api/auth/handoffs/complete`,
    };
  });
  const api = { createHandoff };
  const view = (props: Partial<Parameters<typeof Dashboard>[0]>) => (
    <Dashboard client={client} api={api} focused dashboard="daily" {...props} />
  );

  // A hidden tab mounts its surface but claims nothing yet.
  const screen = await render(view({ focused: false }));
  await expect.element(screen.getByText('waiting')).toBeVisible();
  expect(createHandoff).not.toHaveBeenCalled();

  await screen.rerender(view({}));
  await expect.element(screen.getByText('ticket-1')).toBeVisible();

  // The same surface keeps its session across dashboard switches and focus.
  await screen.rerender(view({ dashboard: 'reading' }));
  await screen.rerender(view({ dashboard: 'reading', focused: false }));
  await screen.rerender(view({ dashboard: 'reading' }));
  await expect.element(screen.getByText('ticket-1')).toBeVisible();
  expect(createHandoff).toHaveBeenCalledTimes(1);

  // Every dashboard disappears, then a refresh finds a new one.
  await screen.rerender(view({ dashboard: null }));
  await expect.element(screen.getByText('No dashboards yet')).toBeVisible();
  await screen.rerender(view({ dashboard: 'new' }));
  await expect.element(screen.getByText('ticket-2')).toBeVisible();

  // Try again replaces the surface within one render; it never reuses a ticket.
  await screen.rerender(view({ dashboard: 'new', attempt: 1 }));
  await expect.element(screen.getByText('ticket-3')).toBeVisible();
  expect(createHandoff).toHaveBeenCalledTimes(3);
});
