import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { groupSessionsByDate } from './session-groups';

const NOW = new Date(2026, 7, 17, 12);

function session(id: string, daysAgo: number, hour = 10) {
  return {
    id,
    updatedAt: dayjs(NOW)
      .subtract(daysAgo, 'day')
      .hour(hour)
      .minute(0)
      .second(0)
      .millisecond(0)
      .toISOString(),
  };
}

describe('groupSessionsByDate', () => {
  it('uses the agreed relative ranges without reordering the server result', () => {
    const groups = groupSessionsByDate(
      [
        session('today-late', 0, 11),
        session('today-early', 0, 8),
        session('yesterday', 1),
        session('six-days', 6),
        session('seven-days', 7),
        session('twenty-nine-days', 29),
        session('thirty-days', 30),
      ],
      NOW,
    );

    expect(
      groups.map((group) => ({
        label: group.label,
        ids: group.sessions.map(({ id }) => id),
      })),
    ).toEqual([
      { label: 'Today', ids: ['today-late', 'today-early'] },
      { label: 'Yesterday', ids: ['yesterday'] },
      { label: 'Previous 7 Days', ids: ['six-days'] },
      {
        label: 'Previous 30 Days',
        ids: ['seven-days', 'twenty-nine-days'],
      },
      { label: 'July 2026', ids: ['thirty-days'] },
    ]);
  });

  it('keeps older month groups distinct across years', () => {
    const groups = groupSessionsByDate(
      [
        {
          id: 'this-year',
          updatedAt: new Date(2026, 0, 15, 10).toISOString(),
        },
        {
          id: 'last-year',
          updatedAt: new Date(2025, 11, 15, 10).toISOString(),
        },
      ],
      NOW,
    );

    expect(groups.map(({ label }) => label)).toEqual([
      'January 2026',
      'December 2025',
    ]);
  });
});
