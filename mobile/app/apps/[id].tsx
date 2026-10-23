import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SecureSurface } from '../../src/ui/secure-surface';
import { useSession } from '../../src/state/session';
import {
  Busy,
  Notice,
  Action,
  errorText,
  styles,
} from '../../src/ui/primitives';

export default function AppScreen() {
  const { id, entryHash, label } = useLocalSearchParams<{
    id: string;
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
  const handoff = useQuery({
    queryKey: [origin, 'app-handoff', id, epoch, attempt],
    queryFn: ({ signal }) => api!.handoff(id, signal),
    enabled: Boolean(api && app.data),
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
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          title: label || app.data?.name || 'App',
          headerTransparent: false,
          headerRight: () => (
            <Action compact secondary label="Reload" onPress={retry} />
          ),
        }}
      />
      {app.error || handoff.error ? (
        <Notice
          title="Couldn’t open this app"
          detail={errorText(app.error ?? handoff.error)}
          action={{ label: 'Try again', onPress: retry }}
        />
      ) : !data ? (
        <Busy label="Opening your app securely…" />
      ) : (
        <SecureSurface
          key={`${epoch}-${attempt}`}
          origin={origin!}
          handoff={data}
          retry={retry}
          entryHash={entryHash}
        />
      )}
    </SafeAreaView>
  );
}
