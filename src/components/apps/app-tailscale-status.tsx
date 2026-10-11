import { Badge } from '@mantine/core';
import type { AppTailscaleStatus } from '~/app-tailscale';

const labels = {
  disabled: 'Not enabled',
  disconnected: 'Connect Tailscale first',
  unavailable: 'App unavailable',
  starting: 'Advertising',
  'needs-tag': 'Node needs a tag',
  pending: 'Pending approval',
  'https-pending': 'Preparing HTTPS',
  ready: 'Ready',
  error: 'Needs attention',
};

export function AppTailscaleBadge({
  state,
}: {
  state: AppTailscaleStatus['state'];
}) {
  return (
    <Badge
      color={state === 'ready' ? 'green' : state === 'error' ? 'red' : 'gray'}
      style={{ height: 'auto', whiteSpace: 'normal' }}
    >
      {labels[state]}
    </Badge>
  );
}

export function appTailscaleAddress(status: AppTailscaleStatus) {
  if (!status.config?.enabled) return null;
  return (
    status.origin ||
    (status.suffix
      ? `https://${status.config.serviceName}.${status.suffix}`
      : null)
  );
}
