import type { NetworkAccessView } from '~/network-policy';

export function formatNetworkAccess(access: NetworkAccessView | null): string {
  if (!access) return 'not deployed';
  if (access.mode === 'blocked') return 'no external destinations';
  if (access.mode === 'restricted') {
    return `declared destinations only (${access.destinations.join(', ')})`;
  }
  return access.legacy ? 'unrestricted (legacy deployment)' : 'unrestricted';
}
