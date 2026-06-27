import { Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

export function SectionHead({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Group
      justify="space-between"
      align="flex-end"
      wrap="nowrap"
      gap="md"
      mb="lg"
    >
      <Stack gap={2}>
        <Text fw={600} fz="lg">
          {title}
        </Text>
        <Text size="sm" c="dimmed">
          {description}
        </Text>
      </Stack>
      {action}
    </Group>
  );
}
