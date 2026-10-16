import { MantineProvider } from '@mantine/core';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DeviceApproval } from './device-approval';

const CODE = 'WDJB4K7M';
// Better Auth's device endpoints, by the action they perform here.
const ACTIONS: Record<string, string> = {
  '/api/auth/device': 'claim',
  '/api/auth/device/approve': 'approve',
  '/api/auth/device/deny': 'deny',
  '/api/auth/get-session': 'session',
};
const claimed = { user_code: CODE, status: 'pending', client_id: 'hatch-cli' };

type Reply = Response | Promise<Response> | 'network-error';
let replies: Record<string, Reply>;
let calls: { action: string; url: URL; init: RequestInit }[];

beforeEach(() => {
  calls = [];
  replies = { claim: Response.json(claimed) };
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const action = ACTIONS[url.pathname] ?? url.pathname;
    calls.push({ action, url, init: init ?? {} });
    const reply = replies[action];
    if (reply === 'network-error') throw new TypeError('Failed to fetch');
    return (await reply).clone();
  });
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

function page(client: QueryClient, initialCode: string) {
  return (
    <MantineProvider>
      <QueryClientProvider client={client}>
        <DeviceApproval
          initialCode={initialCode}
          account="owner@example.com"
          onSignIn={() => {}}
          onSwitchAccount={() => {}}
        />
      </QueryClientProvider>
    </MantineProvider>
  );
}

async function renderPage() {
  const client = new QueryClient();
  const screen = await render(page(client, CODE));
  /** Simulate the route receiving another `user_code` in its URL. */
  const openCode = (code: string) => screen.rerender(page(client, code));
  return Object.assign(screen, { openCode });
}

async function openReview() {
  const screen = await renderPage();
  await screen.getByRole('button', { name: 'Review request' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Approve Hatch CLI?' }))
    .toBeVisible();
  return screen;
}

test('a prefilled link never contacts the server until the person asks to review', async () => {
  const screen = await renderPage();
  await expect
    .element(screen.getByRole('textbox', { name: 'Device code' }))
    .toHaveValue('WDJB-4K7M');
  expect(calls).toEqual([]);

  await screen.getByRole('button', { name: 'Review request' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Approve Hatch CLI?' }))
    .toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].action).toBe('claim');
  expect(calls[0].url.searchParams.get('user_code')).toBe(CODE);
  expect(calls[0].init).toMatchObject({
    credentials: 'same-origin',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
});

test('approval requires confirmation and sends exactly one decision', async () => {
  let release!: (response: Response) => void;
  replies.approve = new Promise((resolve) => (release = resolve));
  const screen = await openReview();
  const approve = screen.getByRole('button', { name: 'Approve' });
  await expect.element(approve).toBeDisabled();
  await expect
    .element(screen.getByRole('button', { name: 'Deny' }))
    .toBeEnabled();

  await screen.getByRole('checkbox').click();
  await approve.click();
  // While the decision is in flight, neither choice can be sent again.
  await expect
    .element(screen.getByRole('button', { name: 'Deny' }))
    .toBeDisabled();
  approve.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  release(Response.json({ success: true }));

  await expect
    .element(screen.getByRole('heading', { name: 'Device approved' }))
    .toBeVisible();
  expect(calls.map((call) => call.action)).toEqual(['claim', 'approve']);
  expect(calls[1].init).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ userCode: CODE }),
  });
});

test('deny does not require confirmation', async () => {
  replies.deny = Response.json({ success: true });
  const screen = await openReview();
  await screen.getByRole('button', { name: 'Deny' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Request denied' }))
    .toBeVisible();
  expect(calls.map((call) => call.action)).toEqual(['claim', 'deny']);
});

test('a decision made offline fails now and is never sent on reconnect', async () => {
  replies.approve = 'network-error';
  const screen = await openReview();
  onlineManager.setOnline(false);
  await screen.getByRole('checkbox').click();
  await screen.getByRole('button', { name: 'Approve' }).click();

  await expect
    .element(
      screen.getByRole('heading', { name: 'Couldn’t confirm your choice' }),
    )
    .toBeVisible();
  replies.approve = Response.json({ success: true });
  onlineManager.setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(screen.container.textContent).not.toContain('Device approved');
  expect(calls.map((call) => call.action)).toEqual(['claim', 'approve']);
});

test('each new step takes focus, even when one problem replaces another', async () => {
  replies.approve = 'network-error';
  const screen = await openReview();
  await screen.getByRole('checkbox').click();
  await screen.getByRole('button', { name: 'Approve' }).click();
  await expect
    .element(
      screen.getByRole('heading', { name: 'Couldn’t confirm your choice' }),
    )
    .toHaveFocus();

  replies.claim = Response.json({ ...claimed, status: 'denied' });
  await screen.getByRole('button', { name: 'Check again' }).click();
  await expect
    .element(
      screen.getByRole('heading', { name: 'This request is already closed' }),
    )
    .toHaveFocus();
});

test('a decision the server rejects is reported, not shown as approved', async () => {
  replies.approve = Response.json(
    { error: 'invalid_request', error_description: 'Already processed' },
    { status: 400 },
  );
  const screen = await openReview();
  await screen.getByRole('checkbox').click();
  await screen.getByRole('button', { name: 'Approve' }).click();

  await expect
    .element(
      screen.getByRole('heading', { name: 'This request is already closed' }),
    )
    .toBeVisible();
  expect(screen.container.textContent).not.toContain('Device approved');
});

test('a different code in the URL starts a separate flow', async () => {
  const screen = await openReview();
  await screen.getByRole('checkbox').click();

  await screen.openCode('XYZW5678');
  await expect
    .element(screen.getByRole('textbox', { name: 'Device code' }))
    .toHaveValue('XYZW-5678');
  expect(screen.container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(calls.map((call) => call.action)).toEqual(['claim']);
});

test('a request claimed by another account cannot be reviewed here', async () => {
  replies.claim = Response.json({ user_code: CODE, status: 'pending' });
  replies.session = Response.json({ user: { id: 'owner' } });
  const screen = await renderPage();
  await screen.getByRole('button', { name: 'Review request' }).click();
  await expect
    .element(
      screen.getByRole('heading', { name: 'Claimed by another account' }),
    )
    .toBeVisible();
  expect(screen.container.querySelector('input[type="checkbox"]')).toBeNull();
});

test('a rate-limited review reports the server’s remaining wait', async () => {
  replies.claim = Response.json(
    { message: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'X-Retry-After': '420' } },
  );
  const screen = await renderPage();
  await screen.getByRole('button', { name: 'Review request' }).click();
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('Too many attempts. Try again in about 7 minutes.');
});

test('the verified mobile client identity is displayed before approval', async () => {
  replies.claim = Response.json({ ...claimed, client_id: 'hatch-mobile' });
  const screen = await renderPage();
  await screen.getByRole('button', { name: 'Review request' }).click();
  await expect
    .element(screen.getByRole('heading', { name: 'Approve Hatch Mobile?' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Approve' }))
    .toBeDisabled();
  expect(calls.map((call) => call.action)).toEqual(['claim']);
});
