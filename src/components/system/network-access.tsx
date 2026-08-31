import { Code, Group, Stack, Text } from '@mantine/core';
import type { NetworkAccessView } from '~/network-policy';

export function NetworkAccessDetails({
  access,
  appPlatformChannels = false,
}: {
  access: NetworkAccessView | null;
  appPlatformChannels?: boolean;
}) {
  if (!access) {
    return (
      <Text size="sm" c="dimmed">
        Not deployed
      </Text>
    );
  }

  const summary =
    access.mode === 'blocked'
      ? 'No external destinations'
      : access.mode === 'restricted'
        ? 'Declared destinations only'
        : access.legacy
          ? 'Unrestricted (legacy deployment)'
          : 'Unrestricted';

  return (
    <Stack gap={5} style={{ minWidth: 0 }}>
      <Text size="sm">{summary}</Text>
      {access.destinations.length > 0 ? (
        <Group gap={6} wrap="wrap">
          {access.destinations.map((destination) => (
            <Code key={destination}>{destination}</Code>
          ))}
        </Group>
      ) : null}
      <Text size="xs" c="dimmed">
        Covers HTTP, HTTPS, TCP, UDP, DNS, and network listeners through Deno.
        {appPlatformChannels
          ? ' The platform listener and enabled Database, Data Tables, KV, and Workflow channels remain available.'
          : ''}
      </Text>
    </Stack>
  );
}
