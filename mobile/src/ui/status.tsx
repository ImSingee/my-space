import { Tag } from './primitives';

export function StatusTag({ status }: { status: string }) {
  switch (status) {
    case 'deployed':
      return <Tag tone="lime" label="Live" />;
    case 'building':
      return <Tag tone="outline" label="Building" />;
    case 'failed':
      return <Tag tone="danger" label="Failed" />;
    default:
      return <Tag tone="quiet" label={status || 'Unknown'} />;
  }
}

export function statusText(status: string) {
  return status === 'deployed'
    ? 'Live'
    : status.charAt(0).toUpperCase() + status.slice(1);
}
