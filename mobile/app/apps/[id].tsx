import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useId, useRef, useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  appDestination,
  type BrowserDestination,
  type DeepLink,
} from '../../src/core';
import { openSurfaceLink } from '../../src/state/deep-links';
import { SecureSurface, type SurfaceHandle } from '../../src/ui/secure-surface';
import { useSession } from '../../src/state/session';
import { useLinkedId } from '../../src/state/use-linked-id';
import { useWebHistoryBack } from '../../src/state/use-web-history-back';
import { glyphs } from '../../src/ui/glyph.types';
import { Busy, Notice, errorText } from '../../src/ui/primitives';
import { palette as c } from '../../src/ui/theme';

export default function AppScreen() {
  // Pins pass their own slug, label and hash; other entries resolve the slug.
  const { id, slug, entryHash, label } = useLocalSearchParams<{
    id: string;
    slug?: string;
    entryHash?: string;
    label?: string;
  }>();
  const { api, origin, epoch } = useSession();
  const [attempt, setAttempt] = useState(0);
  // Each screen signs in with its own one-use ticket, even for the same App.
  const screen = useId();
  // Back steps through the App's own pages first, then leaves the screen.
  const surface = useRef<SurfaceHandle>(null);
  const [inPageBack, setInPageBack] = useState(false);
  useWebHistoryBack(inPageBack, () => surface.current?.goBack());
  const linked = useLinkedId('apps', id, slug);
  const app = useQuery({
    queryKey: [origin, 'app', linked.id],
    queryFn: ({ signal }) => api!.app(linked.id!, signal),
    enabled: Boolean(api && linked.id),
  });
  const appSlug = slug || app.data?.slug;
  let destination: BrowserDestination | null = null;
  let invalid: unknown = null;
  try {
    destination = appSlug ? appDestination(appSlug, entryHash) : null;
  } catch (error) {
    invalid = error;
  }
  const handoff = useQuery({
    queryKey: [origin, 'browser-handoff', 'app', id, screen, epoch, attempt],
    queryFn: ({ signal }) => api!.createHandoff(signal),
    enabled: Boolean(api && destination),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = () => {
    linked.retry();
    void app.refetch();
    setAttempt((value) => value + 1);
  };
  // A link to this App's own route moves this page there as a step in its
  // history, so back returns to the page it came from; anything else opens
  // over it.
  const route = (link: DeepLink) => {
    const { target } = link;
    if (
      (link.instance ?? origin) === origin &&
      target.kind === 'app' &&
      target.slug === appSlug
    )
      surface.current?.showRoute(target.hash ?? '');
    else openSurfaceLink(link);
  };
  const data = handoff.data;
  const name = label || app.data?.name || 'App';
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.card }}
      edges={['left', 'right']}
    >
      <Stack.Screen
        options={{
          title: name,
          gestureEnabled: !inPageBack,
          headerTransparent: false,
          headerStyle: { backgroundColor: c.card },
        }}
      />
      {/* A native bar item, not a custom view, so the system can move it to
          the vertical bar on iPhone Duo or into the overflow menu. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={glyphs.refresh} onPress={retry}>
          Reload app
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {invalid ||
      linked.error ||
      handoff.error ||
      (app.error && !destination) ? (
        <View style={{ flex: 1, padding: 16, backgroundColor: c.paper }}>
          <Notice
            tone="danger"
            title="Couldn’t open this app"
            detail={errorText(
              invalid ?? linked.error ?? handoff.error ?? app.error,
            )}
            action={{ label: 'Try again', onPress: retry }}
          />
        </View>
      ) : !data || !destination ? (
        <Busy label={`Opening ${name}`} />
      ) : (
        <SecureSurface
          ref={surface}
          key={`${epoch}-${attempt}`}
          origin={origin!}
          handoff={data}
          destination={destination}
          retry={retry}
          onHistoryBack={setInPageBack}
          onRoute={route}
        />
      )}
    </SafeAreaView>
  );
}
