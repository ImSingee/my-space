import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sectionsOf, stamp } from './session-dates';

const zone = process.env.TZ;
beforeAll(() => {
  // US clocks fall back on 2026-11-01, so that day lasts 25 hours.
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const session = (id: string, updatedAt: string) => ({
  id,
  title: id,
  appIds: [],
  providerId: null,
  modelId: null,
  messageCount: 1,
  updatedAt,
});

describe('conversation dates follow the local calendar across DST', () => {
  it('keeps just after midnight on the long day in Yesterday with a time', () => {
    const now = new Date('2026-11-02T15:00:00Z'); // 10:00 EST
    const early = '2026-11-01T04:30:00Z'; // 00:30 EDT on Nov 1
    const sections = sectionsOf([session('a', early)], now);
    expect(sections.map((section) => section.title)).toEqual(['Yesterday']);
    expect(stamp(early, now)).not.toMatch(/Sun/);
    expect(stamp('2026-10-31T15:00:00Z', now)).toMatch(/Sat/);
  });

  it('starts This week six calendar days back and Earlier before it', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    const sections = sectionsOf(
      [
        session('week', '2026-10-27T04:30:00Z'), // 00:30 EDT, six days back
        session('old', '2026-10-27T03:30:00Z'), // 23:30 EDT, seven days back
      ],
      now,
    );
    expect(sections).toEqual([
      { title: 'This week', data: [expect.objectContaining({ id: 'week' })] },
      { title: 'Earlier', data: [expect.objectContaining({ id: 'old' })] },
    ]);
  });
});
