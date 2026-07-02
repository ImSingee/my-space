import { Box, Group, Text } from '@mantine/core';
import type { ReactNode } from 'react';

// Flat section header: the title's status / value flows inline right after the
// label (as `meta`) instead of being pinned to the far right — there is no card
// frame to anchor a right edge against anymore.
export function SectionHeader({
  icon,
  title,
  meta,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
}) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <Text fw={600} size="sm">
        {title}
      </Text>
      {meta}
    </Group>
  );
}

// A small, flat status indicator (not a pill badge): ember when active, muted
// otherwise.
export function StatusDot({ active }: { active: boolean }) {
  return (
    <Box
      aria-hidden
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        backgroundColor: active
          ? 'var(--mantine-color-ember-6)'
          : 'var(--mantine-color-gray-4)',
      }}
    />
  );
}
