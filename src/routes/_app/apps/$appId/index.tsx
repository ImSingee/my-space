import { ActionIcon, Box, Group, Text, Tooltip } from '@mantine/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useRef } from 'react';
import { StatusBadge } from '~components/apps/status-badge';
import { getApp } from '~server/apps';
import classes from './app-view.module.css';

export const Route = createFileRoute('/_app/apps/$appId/')({
  loader: async ({ params }) => {
    const app = await getApp({ data: params.appId });
    if (!app) throw notFound();
    return app;
  },
  component: AppView,
});

function AppView() {
  const app = Route.useLoaderData();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const src = `/app/${app.id}/`;
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const canOpen = app.status === 'deployed' && hasFrontend;

  return (
    <Box className={classes.root}>
      <Box className={classes.bar}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={600} truncate>
            {app.name}
          </Text>
          <StatusBadge status={app.status} />
        </Group>
        {canOpen ? (
          <Group gap={4} wrap="nowrap">
            <Tooltip label="Reload" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Reload app"
                onClick={() => {
                  if (frameRef.current) frameRef.current.src = src;
                }}
              >
                <IconRefresh size={18} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Open in new tab" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                component="a"
                href={src}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in new tab"
              >
                <IconExternalLink size={18} stroke={1.7} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ) : null}
      </Box>
      {canOpen ? (
        <iframe
          ref={frameRef}
          src={src}
          title={app.name}
          className={classes.frame}
        />
      ) : (
        <Box className={classes.empty}>
          <Text c="dimmed">
            {app.status !== 'deployed'
              ? 'This app is not deployed yet. Deploy it to use it here.'
              : 'This app has no frontend — it only runs a backend (cron, webhook, storage).'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
