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

  const daysAgo = today.diff(value.startOf('day'), 'day');
  if (daysAgo <= 0) return { key: 'today', label: 'Today' };
  if (daysAgo === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (daysAgo < 7) {
    return { key: 'previous-7-days', label: 'Previous 7 Days' };
  }
  if (daysAgo < 30) {
    return { key: 'previous-30-days', label: 'Previous 30 Days' };
  }
  return {
    key: value.format('YYYY-MM'),
    label: value.format('MMMM YYYY'),
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
