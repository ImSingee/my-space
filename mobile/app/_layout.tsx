import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';
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
        contentStyle: { backgroundColor: c.background },
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
        <Stack.Screen name="index" options={{ title: 'Hatch' }} />
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
  const dark = useColorScheme() === 'dark';
  return (
    <ThemeProvider value={dark ? DarkTheme : DefaultTheme}>
      <SessionProvider>
        <Navigation />
      </SessionProvider>
    </ThemeProvider>
  );
}
