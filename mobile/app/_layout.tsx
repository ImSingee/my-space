import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Appearance } from 'react-native';
import { useEffect } from 'react';
import { fonts, palette as c } from '../src/ui/theme';
import { SessionProvider, useSession } from '../src/state/session';
import { Busy } from '../src/ui/primitives';
import {
  NavigationProvider,
  useNavigationPreferences,
} from '../src/state/navigation';

function Navigation() {
  const { ready, origin, epoch } = useSession();
  const navigation = useNavigationPreferences();
  if (!ready || !navigation.ready) return <Busy label="Opening Hatch…" />;
  return (
    <Stack
      key={epoch}
      screenOptions={{
        contentStyle: { backgroundColor: c.paper },
        statusBarStyle: 'dark',
        headerStyle: { backgroundColor: c.paper },
        headerTintColor: c.ink,
        headerTitleStyle: {
          color: c.ink,
          fontFamily: fonts.display,
          fontWeight: '700',
        },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Protected guard={!origin}>
        <Stack.Screen
          name="connect"
          options={{ title: 'Connect to Hatch', headerShown: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(origin)}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="library" options={{ title: '' }} />
        <Stack.Screen name="navigation" options={{ title: '' }} />
        <Stack.Screen name="workflows/[id]" options={{ title: '' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="apps/[id]" options={{ title: 'App' }} />
        <Stack.Screen
          name="settings"
          options={{ headerShown: false, presentation: 'modal' }}
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
          primary: c.moss,
          background: c.paper,
          card: c.paper,
          text: c.ink,
          border: c.rule,
        },
      }}
    >
      <NavigationProvider>
        <SessionProvider>
          <Navigation />
        </SessionProvider>
      </NavigationProvider>
    </ThemeProvider>
  );
}
