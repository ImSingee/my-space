import { expect, test, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { groupSessionsByDate } from './session-groups';
import { useLocalCalendarNow } from './use-local-calendar-now';

test('refreshes local date groups at midnight', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 17, 23, 59, 59, 900));
  const session = {
    updatedAt: new Date(2026, 7, 17, 12).toISOString(),
  };
  const hook = await renderHook(() => useLocalCalendarNow());

  try {
    expect(groupSessionsByDate([session], hook.result.current)[0]?.label).toBe(
      'Today',
    );
    await hook.act(() => vi.advanceTimersByTimeAsync(200));
    expect(groupSessionsByDate([session], hook.result.current)[0]?.label).toBe(
      'Yesterday',
    );
  } finally {
    await hook.unmount();
    vi.useRealTimers();
  }
});
