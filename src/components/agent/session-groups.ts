import dayjs, { type Dayjs } from 'dayjs';

type UpdatedSession = {
  updatedAt: string;
};

export type SessionDateGroup<T extends UpdatedSession> = {
  key: string;
  label: string;
  sessions: T[];
};

function groupIdentity(
  value: Dayjs,
  today: Dayjs,
): Pick<SessionDateGroup<UpdatedSession>, 'key' | 'label'> {
  if (!value.isValid()) return { key: 'unknown', label: 'Unknown date' };

  const date = value.startOf('day');
  const daysAgo = today.diff(date, 'day');
  if (daysAgo <= 0) {
    return { key: today.format('YYYY-MM-DD'), label: 'Today' };
  }

  const key = date.format('YYYY-MM-DD');
  if (daysAgo === 1) return { key, label: 'Yesterday' };
  if (daysAgo < 7) {
    return { key, label: date.format('dddd') };
  }
  return {
    key,
    label: date.format(
      date.year() === today.year() ? 'MMMM D' : 'MMMM D, YYYY',
    ),
  };
}

/** Group the server-sorted session summaries by the viewer's local calendar. */
export function groupSessionsByDate<T extends UpdatedSession>(
  sessions: readonly T[],
  now: Date = new Date(),
): SessionDateGroup<T>[] {
  const today = dayjs(now).startOf('day');
  const groups = new Map<string, SessionDateGroup<T>>();

  for (const session of sessions) {
    const identity = groupIdentity(dayjs(session.updatedAt), today);
    const existing = groups.get(identity.key);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(identity.key, { ...identity, sessions: [session] });
    }
  }

  return [...groups.values()];
}
