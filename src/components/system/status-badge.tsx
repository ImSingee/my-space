import { Badge } from '@mantine/core';
import type { AppStatus, WorkflowStatus } from '~/db/schema';

/** Apps and workflows share the same lifecycle states (and badge styling). */
type LifecycleStatus = AppStatus | WorkflowStatus;

const statusMeta: Record<LifecycleStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'gray' },
  building: { label: 'Building', color: 'ember' },
  deployed: { label: 'Live', color: 'ember' },
  failed: { label: 'Failed', color: 'red' },
  archived: { label: 'Archived', color: 'gray' },
};

export function StatusBadge({ status }: { status: LifecycleStatus }) {
  // "Live" is the expected healthy state, so we don't badge it — only surface
  // statuses that actually need attention (draft / building / failed / archived).
  if (status === 'deployed') return null;
  const meta = statusMeta[status] ?? statusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {meta.label}
    </Badge>
  );
}
