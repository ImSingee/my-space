import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconBell } from '@tabler/icons-react';
import type { NormalizedManifest } from '~server/apps/manifest';
import { SectionHeader } from './section-header';

/** Read-only view of what the live deployment declares for notifications. */
export function NotificationsSection({
  notifications,
}: {
  notifications: NonNullable<NormalizedManifest['notifications']>;
}) {
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconBell size={16} stroke={1.8} />}
        title="Notifications"
        meta={
          <Text size="xs" c="dimmed">
            {notifications.kinds.length} kind
            {notifications.kinds.length === 1 ? '' : 's'}
            {notifications.destination ? ' · accepts notifications' : ''}
          </Text>
        }
      />
      {notifications.kinds.length > 0 ? (
        <Group gap={6}>
          {notifications.kinds.map((entry) => (
            <Badge
              key={entry.kind}
              variant="light"
              color="gray"
              radius="sm"
              title={entry.description ?? entry.kind}
            >
              {entry.name} · {entry.kind}
            </Badge>
          ))}
        </Group>
      ) : null}
      <Text size="xs" c="dimmed">
        {notifications.destination
          ? 'This App can be chosen as a destination; routed notifications reach its backend at /__notification. '
          : ''}
        Choose where these notifications go in{' '}
        <Anchor component={Link} to="/settings/notifications" size="xs">
          Settings → Notifications
        </Anchor>
        .
      </Text>
    </Stack>
  );
}
