import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Appearance } from 'react-native';
import { useEffect } from 'react';
import { hatchPalette } from '../src/ui/theme';
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
        statusBarStyle: 'dark',
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.accentText,
        headerTitleStyle: { color: c.text },
        headerShadowVisible: false,
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
  useEffect(() => {
    Appearance.setColorScheme('light');
    return () => Appearance.setColorScheme('auto');
  }, []);
  return (
    <ThemeProvider
      value={{
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          primary: hatchPalette.accentText,
          background: hatchPalette.background,
          card: hatchPalette.card,
          text: hatchPalette.text,
          border: hatchPalette.border,
        },
      }}
    >
      <SessionProvider>
        <Navigation />
      </SessionProvider>
    </ThemeProvider>
  );
}
