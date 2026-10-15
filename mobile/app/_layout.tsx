import { Stack } from 'expo-router';
import { SessionProvider, useSession } from '../src/state/session';
import { Busy, usePalette } from '../src/ui/primitives';

function Navigation() {
  const { ready, origin, epoch } = useSession();
  const c = usePalette();
  if (!ready) return <Busy label="Opening Hatch…" />;
  return (
    <Stack
      key={epoch}
      screenOptions={{
        headerTintColor: c.accent,
        headerStyle: { backgroundColor: c.background },
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
        statusBarStyle: c.dark ? 'light' : 'dark',
      }}
    >
      <Stack.Protected guard={!origin}>
        <Stack.Screen
          name="connect"
          options={{ title: 'Connect to Hatch', headerShown: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(origin)}>
        <Stack.Screen
          name="index"
          options={{ title: 'Hatch', headerLargeTitle: true }}
        />
        <Stack.Screen name="chat/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="apps/[id]" options={{ title: 'App' }} />
        <Stack.Screen
          name="settings"
          options={{
            title: 'Your instance',
            presentation: 'modal',
          }}
        />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <Navigation />
    </SessionProvider>
  );
}
