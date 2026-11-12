import { Box, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/** Sub-section heading inside the notification settings page. */
export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-end" gap="md">
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text fw={600}>{title}</Text>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      </Stack>
      {action ? <Box style={{ flex: 'none' }}>{action}</Box> : null}
    </Group>
  );
}
