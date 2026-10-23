import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useSession } from '../src/state/session';
import {
  Action,
  Card,
  Text,
  errorText,
  styles,
  usePalette,
} from '../src/ui/primitives';

export default function SettingsScreen() {
  const { origin, disconnect } = useSession();
  const c = usePalette();
  const [busy, setBusy] = useState(false);
  const signOut = () =>
    Alert.alert(
      'Sign out of this instance?',
      'This removes the saved session from this phone and closes your app views.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            void disconnect()
              .catch((error: unknown) =>
                Alert.alert('Check device access', errorText(error)),
              )
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Card>
        <Text style={[styles.label, { color: c.accentText }]}>
          Connected instance
        </Text>
        <Text
          selectable
          style={[styles.body, { color: c.text, fontWeight: '600' }]}
        >
          {origin ?? ''}
        </Text>
        <Text style={[styles.caption, { color: c.muted }]}>
          Your session is stored securely on this phone. Hatch accounts have
          full access to their instance.
        </Text>
        <Action
          fullWidth
          label="Open Hatch web"
          secondary
          onPress={() => {
            if (origin)
              void WebBrowser.openBrowserAsync(origin).catch((error: unknown) =>
                Alert.alert('Couldn’t open browser', errorText(error)),
              );
          }}
        />
      </Card>
      <View style={{ gap: 12, paddingVertical: 8 }}>
        <Text
          accessibilityRole="header"
          style={[styles.heading, { color: c.text }]}
        >
          Your workspace, always with you
        </Text>
        <Text style={[styles.body, { color: c.muted }]}>
          Your Agent runs on your Hatch server. You can leave the app and return
          to catch up. No background execution on your phone is required.
        </Text>
        <Text style={[styles.caption, { color: c.muted }]}>
          Provider setup, secrets, dashboard editing, and account management
          remain in the Hatch web app.
        </Text>
      </View>
      <Action
        fullWidth
        label={busy ? 'Signing out…' : 'Sign out'}
        disabled={busy}
        danger
        secondary
        onPress={signOut}
      />
      <Action fullWidth label="Done" onPress={() => router.back()} />
    </ScrollView>
  );
}
