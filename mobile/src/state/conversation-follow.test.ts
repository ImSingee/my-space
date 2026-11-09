import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  AFTER_END_MS,
  START_GRACE_MS,
  followKey,
  listRead,
  markConversationWorking,
  needsRead,
  nextListRead,
  observe,
  type FollowedConversation,
} from './conversation-follow';

const origin = 'https://hatch.example';

function marked(at = 0) {
  const queryClient = new QueryClient();
  markConversationWorking(queryClient, origin, 's1', at);
  const list = queryClient.getQueryData<FollowedConversation[]>(
    followKey(origin),
  )!;
  return { queryClient, entry: list[0] };
}

/** Drive list re-reads until none are left, returning when each happened. */
function settle(list: FollowedConversation[], from: number) {
  const reads: number[] = [];
  let now = from;
  while (list.length) {
    const wait = Math.min(
      ...list.map((entry) => nextListRead(entry, now) ?? Infinity),
    );
    if (wait === Infinity) break;
    now += wait;
    reads.push(now);
    list = listRead(list, now);
  }
  return reads;
}

describe('the conversation list follows a run started just before leaving', () => {
  it('keeps following when the run is not on the server yet', () => {
    // Left before createRun or its refetch landed: the first read is idle.
    let { entry } = marked(0);
    entry = observe(entry, false, 2000);
    expect(needsRead(entry)).toBe(true);
    entry = observe(entry, true, 7000);
    entry = observe(entry, true, 60_000);
    expect(needsRead(entry)).toBe(true);
    entry = observe(entry, false, 65_000);
    expect(entry.endedAt).toBe(65_000);
    // A transcript saved after the run ends is picked up by later re-reads.
    expect(settle([entry], 65_000)).toEqual(
      AFTER_END_MS.map((offset) => 65_000 + offset),
    );
  });

  it('lets go after the grace period when the run never started', () => {
    let { entry } = marked(0);
    for (const at of [5000, 10_000, 15_000]) entry = observe(entry, false, at);
    expect(needsRead(entry)).toBe(true);
    entry = observe(entry, false, START_GRACE_MS + 1000);
    expect(needsRead(entry)).toBe(false);
    expect(settle([entry], START_GRACE_MS + 1000)).toHaveLength(
      AFTER_END_MS.length,
    );
  });

  it('ignores failed reads and starts over when another run is asked for', () => {
    const { queryClient, entry } = marked(0);
    expect(observe(entry, null, 90_000)).toBe(entry);
    // Repeated reads of a working run change nothing, so nothing is rewritten.
    const working = observe(entry, true, 1000);
    expect(observe(working, true, 6000)).toBe(working);
    markConversationWorking(queryClient, origin, 's1', 5000);
    expect(
      queryClient.getQueryData<FollowedConversation[]>(followKey(origin)),
    ).toEqual([
      {
        sessionId: 's1',
        since: 5000,
        sawRun: false,
        endedAt: null,
        listReads: 0,
      },
    ]);
  });
});
