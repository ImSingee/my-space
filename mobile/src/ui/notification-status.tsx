import { Tag } from './primitives';

const notificationLabels: Record<string, string> = {
  unrouted: 'Not routed',
  pending: 'Sending',
  delivered: 'Delivered',
  partial: 'Partly failed',
  failed: 'Failed',
};

/** Overall state of a notification across its destinations. */
export function NotificationStatusTag({ status }: { status: string }) {
  const label = notificationLabels[status] ?? status;
  const tone =
    status === 'delivered'
      ? 'lime'
      : status === 'failed' || status === 'partial'
        ? 'danger'
        : status === 'pending'
          ? 'outline'
          : 'quiet';
  return <Tag tone={tone} label={label} />;
}

const deliveryLabels: Record<string, string> = {
  pending: 'Waiting',
  in_progress: 'Sending',
  succeeded: 'Delivered',
  failed: 'Failed',
};

export function DeliveryStatusTag({ status }: { status: string }) {
  return (
    <Tag
      tone={
        status === 'succeeded'
          ? 'lime'
          : status === 'failed'
            ? 'danger'
            : 'outline'
      }
      label={deliveryLabels[status] ?? status}
    />
  );
}

export function notificationTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
