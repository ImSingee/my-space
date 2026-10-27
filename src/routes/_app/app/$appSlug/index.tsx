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
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  isNotFound,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconDots,
  IconAlertTriangle,
  IconExternalLink,
  IconRefresh,
  IconRocket,
  IconServerBolt,
  IconSettings,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { getAppViewState } from '~components/apps/app-view-policy';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import { appViewQueryOptions } from '~queries/apps';
import { getAppDeploymentRevision } from '~server/apps';
import classes from './app-view.module.css';

export const Route = createFileRoute('/_app/app/$appSlug/')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.fetchQuery({
      ...appViewQueryOptions(params.appSlug),
      staleTime: 0,
    }),
  component: AppView,
});

const readDeploymentRevision = (appId: string) =>
  getAppDeploymentRevision({ data: appId });

// The still percent-encoded fragment of an href, without '#'. Hashes move
// between the host and app URLs in this form only: decoding would turn an
// escaped `%2520` into `%20` and change what the app's route points at.
function rawFragment(href: string) {
  const index = href.indexOf('#');
  return index < 0 ? '' : href.slice(index + 1);
}

// Comparison key for fragments: encodes what a URL would encode, but never
// decodes existing escapes, so distinct fragments never compare equal.
function canonicalFragment(fragment: string) {
  return new URL(`#${fragment}`, 'http://fragment.invalid').hash.slice(1);
}

// Moves the app to another page without adding a history entry. The URL must
// be absolute (a relative one resolves against the calling host document) and
// keep its '#' even when empty, so it stays a same-document fragment change.
function replaceInnerHash(win: Window, fragment: string) {
  const [base] = win.location.href.split('#');
  win.location.replace(`${base}#${fragment}`);
}

function AppView() {
  const { appSlug } = Route.useParams();
  const appQueryOptions = appViewQueryOptions(appSlug);
  const { data: app } = useSuspenseQuery(appQueryOptions);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The live iframe window, tracked so a hash change on the host (e.g. clicking
  // a sidebar pin with a custom entry point while the app is already open) can
  // be pushed into the already-loaded app without reloading it.
  const winRef = useRef<Window | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameKey, setFrameKey] = useState(0);
  const [reloading, setReloading] = useState(false);
  // Both human-facing routes use the same mutable slug. Immutable ids stay in
  // technical API paths and never appear in these links.
  const src = `/app/${app.slug}/embed/`;
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const { canOpen, hasLiveDeployment, isCompatibilityBlocked } =
    getAppViewState({
      status: app.status,
      deploymentRevision: app.deploymentRevision,
      hasFrontend,
      runtimeSupported: app.compatibility?.isSupported ?? false,
    });
  const platformUpdateRequired = Boolean(
    isCompatibilityBlocked &&
    app.compatibility &&
    app.compatibility.version > app.compatibility.latestVersion,
  );
  const { updateAvailable } = useAppDeploymentUpdate({
    appId: app.id,
    deploymentRevision: app.deploymentRevision,
    revisionReader: readDeploymentRevision,
  });
  const router = useRouter();
  // The location the view is rendered for: its raw fragment (e.g. '/settings';
  // '' = root) and its history entry key, which changes on every navigation
  // even when the fragment stays the same. While a navigation to another app
  // is still loading, these keep describing the outgoing app.
  const hostFragment = useRouterState({
    select: (s) => rawFragment((s.resolvedLocation ?? s.location).href),
  });
  const hostEntryKey = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).state.__TSR_key,
  });

  // Mirror the embedded app's URL hash and document title out to the host page:
  // the host URL stays shareable/refreshable (its hash deep-links into the app)
  // and the browser tab reflects whichever page the user is on inside the app.
  // Also clears the loading overlay — on a direct load the iframe can finish
  // before this effect runs, so the native `load` event would be missed; the
  // already-complete check below handles that case.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !canOpen) return;

    setLoading(true);
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
        const fragment = rawFragment(win?.location.href ?? '');
        const { latestLocation, state } = router;
        const resolved = state.resolvedLocation ?? state.location;
        // A navigation away from this app is in flight; don't override it.
        if (latestLocation.pathname !== resolved.pathname) return;
        if (
          canonicalFragment(fragment) ===
          canonicalFragment(rawFragment(latestLocation.href))
        )
          return;
        void router.navigate({
          to: '/app/$appSlug',
          params: { appSlug },
          // The router writes `hash` into the URL verbatim, so pass it encoded.
          hash: fragment,
          replace: true,
          resetScroll: false,
          hashScrollIntoView: false,
        });
      } catch {
        // cross-origin frame
      }
    };

    const onInnerChange = () => {
      syncHashOut();
      syncTitle();
    };

    // Hash routers usually navigate with `history.pushState`, which never fires
    // `hashchange`; the Navigation API reports every same-document change.
    // Without it, fall back to the events fragment and history traversals fire.
    const innerEvents = (target: Window) =>
      target.navigation
        ? ([[target.navigation, 'currententrychange']] as const)
        : ([
            [target, 'popstate'],
            [target, 'hashchange'],
          ] as const);

    const detach = () => {
      try {
        if (win) {
          for (const [target, type] of innerEvents(win)) {
            target.removeEventListener(type, onInnerChange);
          }
        }
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
        const seed = rawFragment(router.state.location.href);
        if (
          seed &&
          canonicalFragment(rawFragment(next.location.href)) !==
            canonicalFragment(seed)
        ) {
          replaceInnerHash(next, seed);
        }
        for (const [target, type] of innerEvents(next)) {
          target.addEventListener(type, onInnerChange);
        }
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
  }, [appSlug, canOpen, frameKey, router, src]);

  // Push each host navigation into the already-loaded app. The seed-on-load
  // above covers fresh loads (and app switches, which mount a new iframe); this
  // covers navigations within the current app, such as selecting its sidebar
  // pin or going back, where the iframe document stays put. It runs per history
  // entry rather than per hash value, so selecting a pin still resets the app
  // when the host hash had not caught up with the app's own navigation yet.
  // Replacing keeps the host entry the only new history entry. The equality
  // guard converges with the iframe→host mirror above (no ping-pong).
  useEffect(() => {
    const win = winRef.current;
    if (!win || !canOpen) return;
    const resolved = router.state.resolvedLocation ?? router.state.location;
    // A newer navigation is still loading; its resolution re-runs this.
    if (router.latestLocation.href !== resolved.href) return;
    try {
      if (
        canonicalFragment(rawFragment(win.location.href)) !==
        canonicalFragment(hostFragment)
      ) {
        replaceInnerHash(win, hostFragment);
      }
    } catch {
      // cross-origin frame
    }
  }, [hostEntryKey, hostFragment, canOpen, router]);

  const queryClient = useQueryClient();
  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    setLoading(true);
    try {
      // Refetch through the query rather than invalidating the route: a failed
      // route loader replaces the whole view with an error state, while a
      // failed query refetch keeps the cached snapshot and its running iframe.
      await queryClient.fetchQuery({ ...appQueryOptions, staleTime: 0 });
      setFrameKey((current) => current + 1);
    } catch (error) {
      setLoading(false);
      if (isNotFound(error)) {
        // The app was deleted or renamed; let the loader render not-found.
        await router.invalidate();
        return;
      }
      toast.error(
        error instanceof Error ? error.message : 'Could not reload the app.',
      );
    } finally {
      setReloading(false);
    }
  };

  const reloadLabel = updateAvailable
    ? 'Update available — reload app'
    : 'Reload app';
  // Clicking the pill hands off to the plain reload icon, which carries the
  // loading state; the pill only returns if the reload fails.
  const showUpdatePill = updateAvailable && !reloading;

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
          {canOpen || updateAvailable ? (
            <>
              {showUpdatePill ? (
                <Box component="output" className={classes.update}>
                  <Tooltip label="Reload to apply the new version" withArrow>
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="ember"
                      // The light variant's default ember-6 text is ~3.3:1 on
                      // its tint; ember-8 keeps small text above WCAG AA.
                      c="ember.8"
                      radius="xl"
                      fw={500}
                      className={classes.updateButton}
                      aria-label={reloadLabel}
                      onClick={reload}
                      leftSection={
                        <IconRefresh
                          className={classes.updateIcon}
                          size={15}
                          stroke={2}
                          aria-hidden
                        />
                      }
                    >
                      Update available
                    </Button>
                  </Tooltip>
                </Box>
              ) : (
                <Tooltip label={reloadLabel} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={reloadLabel}
                    loading={reloading}
                    onClick={reload}
                  >
                    <IconRefresh size={18} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              )}
              {canOpen ? (
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
              ) : null}
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
                    to="/app/$appSlug/manage"
                    params={{ appSlug: app.slug }}
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
            // A fresh element per app: reusing it across `src` changes would
            // briefly expose the previous app's document as already loaded.
            key={`${src}:${frameKey}`}
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
              color={
                isCompatibilityBlocked
                  ? 'red'
                  : hasLiveDeployment
                    ? 'gray'
                    : 'ember'
              }
            >
              {isCompatibilityBlocked ? (
                <IconAlertTriangle size={26} stroke={1.5} />
              ) : hasLiveDeployment ? (
                <IconServerBolt size={26} stroke={1.5} />
              ) : (
                <IconRocket size={26} stroke={1.5} />
              )}
            </ThemeIcon>
            <Text fw={600} mt="xs">
              {isCompatibilityBlocked
                ? platformUpdateRequired
                  ? 'Platform update required'
                  : 'App update required'
                : hasLiveDeployment
                  ? 'Backend-only app'
                  : 'Not deployed yet'}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {isCompatibilityBlocked
                ? platformUpdateRequired
                  ? 'This App deployment is newer than the current platform. Update the platform before running it.'
                  : 'This App cannot run on the current platform. Use Agent to update and redeploy it.'
                : hasLiveDeployment
                  ? 'This app has no frontend — it runs a backend (cron or webhook). Open Manage to inspect its capabilities.'
                  : 'Deploy this app to use it here. You can build and deploy it from the Manage page.'}
            </Text>
            <Button
              variant="default"
              mt="sm"
              leftSection={
                isCompatibilityBlocked && !platformUpdateRequired ? (
                  <IconRocket size={16} stroke={1.7} />
                ) : (
                  <IconSettings size={16} stroke={1.7} />
                )
              }
              renderRoot={(props) =>
                isCompatibilityBlocked && !platformUpdateRequired ? (
                  <Link to="/agent" {...props} />
                ) : (
                  <Link
                    to="/app/$appSlug/manage"
                    params={{ appSlug: app.slug }}
                    {...props}
                  />
                )
              }
            >
              {isCompatibilityBlocked && !platformUpdateRequired
                ? 'Open Agent'
                : 'Manage app'}
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
