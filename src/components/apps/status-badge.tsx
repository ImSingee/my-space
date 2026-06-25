import { Badge } from '@mantine/core';
import type { AppStatus } from '~/db/schema';

export const statusMeta: Record<AppStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'gray' },
  building: { label: 'Building', color: 'ember' },
  deployed: { label: 'Live', color: 'teal' },
  failed: { label: 'Failed', color: 'red' },
  archived: { label: 'Archived', color: 'gray' },
};

export function StatusBadge({ status }: { status: AppStatus }) {
  const meta = statusMeta[status] ?? statusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {meta.label}
    </Badge>
  );
}
