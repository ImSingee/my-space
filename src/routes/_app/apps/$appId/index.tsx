import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import {
  IconExternalLink,
  IconRefresh,
  IconRocket,
  IconServerBolt,
  IconSettings,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
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
  const [loading, setLoading] = useState(true);
  const src = `/app/${app.id}/`;
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const canOpen = app.status === 'deployed' && hasFrontend;

  // On a direct (SSR) page load the iframe can finish loading before React
  // hydrates and attaches `onLoad`, so that event is missed and the overlay
  // would hang forever. Detect an already-loaded same-origin frame on mount
  // and clear the overlay; otherwise the later `onLoad` handles it.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    try {
      if (frame.contentDocument?.readyState === 'complete') {
        setLoading(false);
      }
    } catch {
      // Cross-origin frame — nothing readable here; rely on onLoad.
    }
  }, []);

  const reload = () => {
    if (!frameRef.current) return;
    setLoading(true);
    frameRef.current.src = src;
  };

  return (
    <Box className={classes.root}>
      <Box className={classes.bar}>
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <AppGlyph name={app.name} seed={app.id} size="sm" />
          <Text fw={600} truncate>
            {app.name}
          </Text>
        </Group>
        {canOpen ? (
          <Group gap={4} wrap="nowrap">
            <Tooltip label="Reload" withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Reload app"
                onClick={reload}
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
        <Box className={classes.frameWrap}>
          <iframe
            ref={frameRef}
            src={src}
            title={app.name}
            className={classes.frame}
            onLoad={() => setLoading(false)}
          />
          {loading ? (
            <Box className={classes.overlay}>
              <Loader />
            </Box>
          ) : null}
        </Box>
      ) : (
        <Box className={classes.empty}>
          <Stack align="center" gap="xs" maw={440} px="md">
            <ThemeIcon
              size={52}
              radius="xl"
              variant="light"
              color={app.status === 'deployed' ? 'gray' : 'ember'}
            >
              {app.status === 'deployed' ? (
                <IconServerBolt size={26} stroke={1.5} />
              ) : (
                <IconRocket size={26} stroke={1.5} />
              )}
            </ThemeIcon>
            <Text fw={600} mt="xs">
              {app.status === 'deployed'
                ? 'Backend-only app'
                : 'Not deployed yet'}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {app.status === 'deployed'
                ? 'This app has no frontend — it runs a backend (cron, webhook, or storage). Open Manage to inspect its capabilities.'
                : 'Deploy this app to use it here. You can build and deploy it from the Manage page.'}
            </Text>
            <Button
              variant="default"
              mt="sm"
              leftSection={<IconSettings size={16} stroke={1.7} />}
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId/manage"
                  params={{ appId: app.id }}
                  {...props}
                />
              )}
            >
              Manage app
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
