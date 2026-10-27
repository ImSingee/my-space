import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { appDestination, type BrowserDestination } from '../../src/core';
import { SecureSurface } from '../../src/ui/secure-surface';
import { useSession } from '../../src/state/session';
import { IconButton } from '../../src/ui/button';
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
  const app = useQuery({
    queryKey: [origin, 'app', id],
    queryFn: ({ signal }) => api!.app(id, signal),
    enabled: Boolean(api),
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
    queryKey: [origin, 'browser-handoff', 'app', id, epoch, attempt],
    queryFn: ({ signal }) => api!.createHandoff(signal),
    enabled: Boolean(api && destination),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = () => {
    void app.refetch();
    setAttempt((value) => value + 1);
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
          headerTransparent: false,
          headerStyle: { backgroundColor: c.card },
          headerRight: () => (
            <IconButton
              label="Reload app"
              glyph="refresh"
              tone="clear"
              size={36}
              onPress={retry}
            />
          ),
        }}
      />
      {invalid || handoff.error || (app.error && !destination) ? (
        <View style={{ flex: 1, padding: 16, backgroundColor: c.paper }}>
          <Notice
            tone="danger"
            title="Couldn’t open this app"
            detail={errorText(invalid ?? handoff.error ?? app.error)}
            action={{ label: 'Try again', onPress: retry }}
          />
        </View>
      ) : !data || !destination ? (
        <Busy label={`Opening ${name}`} />
      ) : (
        <SecureSurface
          key={`${epoch}-${attempt}`}
          origin={origin!}
          handoff={data}
          destination={destination}
          retry={retry}
        />
      )}
    </SafeAreaView>
  );
}
