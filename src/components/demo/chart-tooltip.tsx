import { Paper, Text } from '@mantine/core';

interface ChartTooltipProps {
  label?: string;
  payload?: Array<{
    name: string;
    value: number;
    color?: string;
  }>;
}

export function ChartTooltip({ label, payload }: ChartTooltipProps) {
  if (!payload || payload.length === 0) return null;

  return (
    <Paper p="xs" shadow="sm">
      <Text size="sm" fw={500}>
        {label}
      </Text>
      {payload.map((item, index) => (
        <Text key={index} size="xs" c="dimmed">
          {item.name}: {item.value}
        </Text>
      ))}
    </Paper>
  );
}
