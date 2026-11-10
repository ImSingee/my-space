import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { HatchApiClient } from '../core';

let lifetimes = 0;
const nextLifetime = () => ++lifetimes;

/**
 * The one-use sign-in ticket for one mounted web surface. A surface claims its
 * ticket the first time it is on screen and keeps it while mounted, so
 * switching what it shows reuses its browser session. A surface mounted again
 * later, even in the same render, has a new lifetime and never inherits a
 * ticket an earlier surface already consumed.
 */
export function useSurfaceHandoff({
  api,
  origin,
  focused,
}: {
  api: Pick<HatchApiClient, 'createHandoff'> | null;
  origin: string | null;
  focused: boolean;
}) {
  const [lifetime] = useState(nextLifetime);
  return useQuery({
    queryKey: [origin, 'browser-handoff', lifetime],
    queryFn: ({ signal }) => api!.createHandoff(signal),
    enabled: Boolean(api) && focused,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
