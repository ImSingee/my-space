import { Badge } from '@mantine/core';
import type { SubappStatus } from '~/db/schema';

export const statusMeta: Record<
  SubappStatus,
  { label: string; color: string }
> = {
  draft: { label: 'Draft', color: 'gray' },
  building: { label: 'Building', color: 'violet' },
  deployed: { label: 'Live', color: 'teal' },
  failed: { label: 'Failed', color: 'red' },
  archived: { label: 'Archived', color: 'gray' },
};

export function StatusBadge({ status }: { status: SubappStatus }) {
  const meta = statusMeta[status] ?? statusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {meta.label}
    </Badge>
  );
}
