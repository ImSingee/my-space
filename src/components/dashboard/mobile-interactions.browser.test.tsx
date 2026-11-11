import { render } from 'vitest-browser-react';
import { afterEach, expect, test, vi } from 'vitest';
import { usePullToRefresh } from '../../../mobile/src/state/use-pull-to-refresh';
import { useDashboardAutoRefresh } from '../../../mobile/src/state/use-dashboard-auto-refresh';
import { useRefreshOnReturn } from '../../../mobile/src/state/use-refresh-on-return';

afterEach(() => vi.useRealTimers());

function Pull({
  refresh,
  focused = true,
}: {
  refresh: () => Promise<unknown>;
  focused?: boolean;
}) {
  const pull = usePullToRefresh(focused, refresh);
  return (
    <>
      <button type="button" onClick={() => void pull.onRefresh()}>
        Pull
      </button>
      <output>{pull.refreshing ? 'Refreshing' : 'Idle'}</output>
    </>
  );
}

function deferred() {
  let settle!: (outcome: 'ok' | 'fail') => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = (outcome) =>
      outcome === 'ok' ? resolve() : reject(new Error('Offline'));
  });
  return { promise, settle };
}

test('a pull keeps its native state while the list is away and settles on return', async () => {
  const first = deferred();
  const second = deferred();
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const screen = await render(<Pull refresh={refresh} />);
  const status = screen.getByRole('status');
  await screen.getByRole('button', { name: 'Pull' }).click();
  await expect.element(status).toHaveTextContent('Refreshing');
  // Off screen the control must not begin or end, even when the pull settles.
  await screen.rerender(<Pull refresh={refresh} focused={false} />);
  first.settle('ok');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(status.element()).toHaveTextContent('Refreshing');
  await screen.rerender(<Pull refresh={refresh} />);
  await expect.element(status).toHaveTextContent('Idle');
  // Returning before it settles shows the pull until it really ends.
  await screen.getByRole('button', { name: 'Pull' }).click();
  await screen.rerender(<Pull refresh={refresh} focused={false} />);
  await screen.rerender(<Pull refresh={refresh} />);
  await expect.element(status).toHaveTextContent('Refreshing');
  second.settle('fail');
  await expect.element(status).toHaveTextContent('Idle');
  expect(refresh).toHaveBeenCalledTimes(2);
});

test('a pull ends on success, a query error result or a rejection', async () => {
  for (const refresh of [
    async () => undefined,
    async () => ({ error: new Error('Offline') }),
    () => Promise.reject(new Error('Offline')),
  ]) {
    const screen = await render(<Pull refresh={refresh} />);
    await screen.getByRole('button', { name: 'Pull' }).click();
    await expect.element(screen.getByRole('status')).toHaveTextContent('Idle');
    await screen.unmount();
  }
});

function Timer({
  enabled = true,
  seconds = 5,
  id = 'daily',
  refresh,
}: {
  enabled?: boolean;
  seconds?: number;
  id?: string;
  refresh: () => void;
}) {
  useDashboardAutoRefresh({ enabled, seconds, dashboardId: id, refresh });
  return null;
}

test('native scheduling stops off-screen/background and restarts for a new dashboard or interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const refresh = vi.fn<() => void>();
  const screen = await render(<Timer refresh={refresh} />);
  await vi.advanceTimersByTimeAsync(5000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<Timer refresh={refresh} enabled={false} />);
  await vi.advanceTimersByTimeAsync(15000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await screen.rerender(<Timer refresh={refresh} id="reading" seconds={10} />);
  await vi.advanceTimersByTimeAsync(9999);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledTimes(2);
  await screen.rerender(<Timer refresh={refresh} seconds={0} />);
  await vi.advanceTimersByTimeAsync(15000);
  expect(refresh).toHaveBeenCalledTimes(2);
});

function Conversation({
  focused,
  refresh,
}: {
  focused: boolean;
  refresh: () => unknown;
}) {
  useRefreshOnReturn(focused, refresh);
  return null;
}

test('a conversation re-reads once each time it is shown again, never on first show or re-render', async () => {
  const first = vi.fn<() => void>();
  const screen = await render(<Conversation focused refresh={first} />);
  expect(first).not.toHaveBeenCalled();
  // A pushed App screen covers the conversation, then closes.
  await screen.rerender(<Conversation focused={false} refresh={first} />);
  await screen.rerender(<Conversation focused refresh={first} />);
  expect(first).toHaveBeenCalledTimes(1);
  // Each render brings a new callback; none of them reads on its own.
  const latest = vi.fn<() => void>();
  await screen.rerender(<Conversation focused refresh={latest} />);
  await screen.rerender(<Conversation focused refresh={() => latest()} />);
  expect(first).toHaveBeenCalledTimes(1);
  expect(latest).not.toHaveBeenCalled();
  await screen.rerender(<Conversation focused={false} refresh={latest} />);
  await screen.rerender(<Conversation focused refresh={latest} />);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
});
