import { Badge, Loader } from '@mantine/core';
import {
  IconAppWindow,
  IconBroadcast,
  IconCheck,
  IconClock,
  IconDeviceMobile,
  IconMinus,
  IconSparkles,
  IconWebhook,
  IconX,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { NotificationStatus } from '~server/notifications';

type DeliveryStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';

const NOTIFICATION_META: Record<
  NotificationStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  unrouted: {
    label: 'Not routed',
    color: 'gray',
    icon: <IconMinus size={11} stroke={2.5} />,
  },
  pending: {
    label: 'Delivering',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  delivered: {
    label: 'Delivered',
    color: 'ember',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  partial: {
    label: 'Partly failed',
    color: 'yellow',
    icon: <IconX size={11} stroke={2.5} />,
  },
  failed: {
    label: 'Failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

export const NOTIFICATION_STATUS_OPTIONS = (
  Object.keys(NOTIFICATION_META) as NotificationStatus[]
).map((value) => ({ value, label: NOTIFICATION_META[value].label }));

export function NotificationStatusBadge({
  status,
}: {
  status: NotificationStatus;
}) {
  const meta = NOTIFICATION_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {meta.label}
    </Badge>
  );
}

const DELIVERY_META: Record<
  DeliveryStatus,
  { label: string; color: string; icon: ReactNode }
> = {
  pending: {
    label: 'Waiting',
    color: 'gray',
    icon: <IconClock size={11} stroke={2.5} />,
  },
  in_progress: {
    label: 'Sending',
    color: 'ember',
    icon: <Loader size={9} color="ember" />,
  },
  succeeded: {
    label: 'Delivered',
    color: 'ember',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    label: 'Failed',
    color: 'red',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const meta = DELIVERY_META[status];
  return (
    <Badge
      color={meta.color}
      variant="light"
      radius="sm"
      leftSection={<span style={{ display: 'inline-flex' }}>{meta.icon}</span>}
    >
      {meta.label}
    </Badge>
  );
}

type DestinationType = 'device' | 'webhook' | 'app';

export const DESTINATION_TYPE_LABEL: Record<DestinationType, string> = {
  device: 'Device',
  webhook: 'Webhook',
  app: 'App',
};

export function DestinationTypeIcon({
  type,
  size = 16,
}: {
  type: DestinationType;
  size?: number;
}) {
  if (type === 'device') return <IconDeviceMobile size={size} stroke={1.6} />;
  if (type === 'webhook') return <IconWebhook size={size} stroke={1.6} />;
  return <IconAppWindow size={size} stroke={1.6} />;
}

export function SourceTypeIcon({
  type,
  size = 16,
}: {
  type: 'app' | 'channel' | 'platform';
  size?: number;
}) {
  if (type === 'app') return <IconAppWindow size={size} stroke={1.6} />;
  if (type === 'channel') return <IconBroadcast size={size} stroke={1.6} />;
  return <IconSparkles size={size} stroke={1.6} />;
}
