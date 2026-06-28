import { Badge } from '@mantine/core';
import type { WorkflowStatus } from '~/db/schema';

export const workflowStatusMeta: Record<
  WorkflowStatus,
  { label: string; color: string }
> = {
  draft: { label: 'Draft', color: 'gray' },
  building: { label: 'Building', color: 'ember' },
  deployed: { label: 'Live', color: 'ember' },
  failed: { label: 'Failed', color: 'red' },
  archived: { label: 'Archived', color: 'gray' },
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  // "Live" is the expected healthy state, so we don't badge it — only surface
  // statuses that need attention (draft / building / failed / archived).
  if (status === 'deployed') return null;
  const meta = workflowStatusMeta[status] ?? workflowStatusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {meta.label}
    </Badge>
  );
}
