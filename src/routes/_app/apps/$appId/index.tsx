import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  Link,
  createFileRoute,
  notFound,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconDots,
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
  // The live iframe window, tracked so a hash change on the host (e.g. clicking
  // a sidebar pin with a custom entry point while the app is already open) can
  // be pushed into the already-loaded app without reloading it.
  const winRef = useRef<Window | null>(null);
  const [loading, setLoading] = useState(true);
  // The shareable app URL uses the mutable slug; the route still resolves the
  // immutable id too, so old `/app/<id>/` links keep working.
  const src = `/app/${app.slug}/`;
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const canOpen = app.status === 'deployed' && hasFrontend;
  // Router hash is the fragment without '#' (e.g. '/settings'); '' = root.
  const hostHash = useRouterState({ select: (s) => s.location.hash });

  // Mirror the embedded app's URL hash and document title out to the host page:
  // the host URL stays shareable/refreshable (its hash deep-links into the app)
  // and the browser tab reflects whichever page the user is on inside the app.
  // Also clears the loading overlay — on a direct (SSR) load the iframe can
  // finish before this effect runs, so the native `load` event would be missed;
  // the already-complete check below handles that case.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !canOpen) return;

    const hostTitle = document.title;
    let win: Window | null = null;
    let titleObserver: MutationObserver | null = null;

    const syncTitle = () => {
      try {
        const inner = frame.contentDocument?.title;
        if (inner && inner !== document.title) document.title = inner;
      } catch {
        // cross-origin frame
      }
    };

    const syncHashOut = () => {
      try {
        const hash = win?.location.hash ?? '';
        if (hash !== window.location.hash) {
          const { pathname, search } = window.location;
          window.history.replaceState(
            window.history.state,
            '',
            `${pathname}${search}${hash}`,
          );
        }
      } catch {
        // cross-origin frame
      }
    };

    const onInnerChange = () => {
      syncHashOut();
      syncTitle();
    };

    const detach = () => {
      try {
        win?.removeEventListener('hashchange', onInnerChange);
      } catch {
        // window already torn down
      }
      titleObserver?.disconnect();
      titleObserver = null;
      win = null;
      winRef.current = null;
    };

    const onLoad = () => {
      const next = frame.contentWindow;
      if (!next) return;
      try {
        // Skip the iframe's transient initial `about:blank` document; the real
        // load fires its own `load` event right after.
        if (next.location.href === 'about:blank') return;
      } catch {
        // cross-origin: can't sync, but the app did load — clear the overlay.
        setLoading(false);
        return;
      }
      setLoading(false);
      detach();
      win = next;
      winRef.current = next;
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        // Deep-link: seed the freshly loaded app with the host's hash once,
        // before listening, so it doesn't immediately echo back out.
        const hostHash = window.location.hash;
        if (hostHash && next.location.hash !== hostHash) {
          next.location.hash = hostHash;
        }
        next.addEventListener('hashchange', onInnerChange);
        const head = doc.head ?? doc.documentElement;
        if (head) {
          titleObserver = new MutationObserver(syncTitle);
          titleObserver.observe(head, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
        onInnerChange();
      } catch {
        // cross-origin frame
      }
    };

    frame.addEventListener('load', onLoad);
    try {
      if (frame.contentDocument?.readyState === 'complete') onLoad();
    } catch {
      // cross-origin frame
    }

    return () => {
      frame.removeEventListener('load', onLoad);
      detach();
      document.title = hostTitle;
    };
  }, [canOpen, src]);

  // Push host hash changes into the already-loaded app. The seed-on-load above
  // covers fresh loads (and app switches, which reload the iframe via `src`);
  // this covers re-selecting a pin for the *current* app at a different entry
  // point, where only the hash changes and the iframe document stays put. The
  // equality guard converges with the iframe→host mirror above (no ping-pong).
  useEffect(() => {
    const win = winRef.current;
    if (!win || !canOpen) return;
    try {
      if (win.location.hash.replace(/^#/, '') !== hostHash) {
        win.location.hash = hostHash;
      }
    } catch {
      // cross-origin frame
    }
  }, [hostHash, canOpen]);

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
        <Group gap={4} wrap="nowrap">
          {canOpen ? (
            <>
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
            </>
          ) : null}
          <Menu position="bottom-end" withArrow shadow="md" width={180}>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="App options"
              >
                <IconDots size={18} stroke={1.7} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconSettings size={15} stroke={1.7} />}
                renderRoot={(props) => (
                  <Link
                    to="/apps/$appId/manage"
                    params={{ appId: app.id }}
                    {...props}
                  />
                )}
              >
                Manage app
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Box>
      {canOpen ? (
        <Box className={classes.frameWrap}>
          <iframe
            ref={frameRef}
            src={src}
            title={app.name}
            className={classes.frame}
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
                ? 'This app has no frontend — it runs a backend (cron or webhook). Open Manage to inspect its capabilities.'
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
