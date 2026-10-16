import { FormButton } from '../src/ui/form-button';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert } from 'react-native';
import { FieldGroup, Host, Text } from '@expo/ui';
import { textSelection } from '@expo/ui/swift-ui/modifiers';
import { useSession } from '../src/state/session';
import { errorText, styles } from '../src/ui/primitives';

export default function SettingsScreen() {
  const { origin, disconnect } = useSession();
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
    <Host style={styles.screen}>
      <FieldGroup>
        <FieldGroup.Section title="Connected instance">
          <Text modifiers={[textSelection(true)]}>{origin ?? ''}</Text>
          <FieldGroup.SectionFooter>
            <Text>
              Your session is stored securely on this phone. Hatch accounts have
              full access to their instance.
            </Text>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>
        <FieldGroup.Section title="Keep building, anywhere">
          <Text>
            Your Agent runs on your Hatch server. You can leave the app and
            return to catch up. No background execution on your phone is
            required.
          </Text>
          <FieldGroup.SectionFooter>
            <Text>
              Provider setup, secrets, dashboards, and account management remain
              in the Hatch web app.
            </Text>
          </FieldGroup.SectionFooter>
        </FieldGroup.Section>
        <FieldGroup.Section>
          <FormButton
            label="Open Hatch web"

            onPress={() => {
              if (origin)
                void WebBrowser.openBrowserAsync(origin).catch(
                  (error: unknown) =>
                    Alert.alert('Couldn’t open browser', errorText(error)),
                );
            }}
          />
          <FormButton
            label={busy ? 'Signing out…' : 'Sign out'}

            unavailable={busy}
            danger
            onPress={signOut}
          />
        </FieldGroup.Section>
        <FieldGroup.Section>
          <FormButton label="Done" onPress={() => router.back()} />
        </FieldGroup.Section>
      </FieldGroup>
    </Host>
  );
}
