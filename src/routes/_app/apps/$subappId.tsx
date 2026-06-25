import { ActionIcon, Box, Group, Text, Tooltip } from '@mantine/core';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useRef } from 'react';
import { StatusBadge } from '~components/subapps/status-badge';
import { getSubapp } from '~server/subapps';
import classes from './app-view.module.css';

export const Route = createFileRoute('/_app/apps/$subappId')({
  loader: async ({ params }) => {
    const subapp = await getSubapp({ data: params.subappId });
    if (!subapp) throw notFound();
    return subapp;
  },
  component: AppView,
});

function AppView() {
  const subapp = Route.useLoaderData();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const src = `/api/subapps/${subapp.id}/app/`;

  return (
    <Box className={classes.root}>
      <Box className={classes.bar}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={600} truncate>
            {subapp.name}
          </Text>
          <StatusBadge status={subapp.status} />
        </Group>
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
      </Box>
      {subapp.status === 'deployed' ? (
        <iframe
          ref={frameRef}
          src={src}
          title={subapp.name}
          className={classes.frame}
        />
      ) : (
        <Box className={classes.empty}>
          <Text c="dimmed">
            This subapp is not deployed yet. Deploy it to use it here.
          </Text>
        </Box>
      )}
    </Box>
  );
}
