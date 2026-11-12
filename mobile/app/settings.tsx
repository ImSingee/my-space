import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, Linking, ScrollView, Switch, View } from 'react-native';
import { pushRegistrar, pushSupported } from '../src/state/push-registrar';
import { useSession } from '../src/state/session';
import { Button, IconButton } from '../src/ui/button';
import type { GlyphName } from '../src/ui/glyph.types';
import { Card, errorText } from '../src/ui/primitives';
import { GlyphTile } from '../src/ui/rows';
import { Masthead, pageScrollProps } from '../src/ui/screen';
import { Text, type } from '../src/ui/text';
import { palette as c } from '../src/ui/theme';

const notes: { glyph: GlyphName; title: string; detail: string }[] = [
  {
    glyph: 'agent',
    title: 'Your Agent works on the server',
    detail:
      'Leave the app whenever you like. Runs keep going on your instance and you can catch up later.',
  },
  {
    glyph: 'browser',
    title: 'Some things stay on the web',
    detail:
      'Providers, secrets, dashboard editing and account management live in Hatch on the web.',
  },
  {
    glyph: 'server',
    title: 'Kept in this phone’s keychain',
    detail:
      'Your session is stored securely on this device. Hatch accounts have full access to their instance.',
  },
];

function PushCard() {
  const { origin, api } = useSession();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const local = useQuery({
    queryKey: [origin, 'push', 'local'],
    queryFn: () => pushRegistrar.enabled(origin!),
    enabled: Boolean(origin),
  });
  const remote = useQuery({
    queryKey: [origin, 'push', 'device'],
    queryFn: ({ signal }) => api!.pushDevice(signal),
    enabled: Boolean(api) && local.data === true,
  });
  if (!pushSupported || !origin || !api) return null;
  const on = local.data === true;
  const problem =
    remote.data === null && on
      ? 'This instance has not registered this phone yet.'
      : remote.data && !remote.data.enabled
        ? (remote.data.lastError ??
          'This phone was turned off for notifications on the instance.')
        : null;
  const toggle = (next: boolean) => {
    setSaving(true);
    void (
      next
        ? pushRegistrar.enable(origin, api)
        : pushRegistrar.disable(origin, api)
    )
      .then((result) => {
        if (next && result === false)
          Alert.alert(
            'Notifications are off',
            'Allow notifications for Hatch in Settings, then try again.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => void Linking.openSettings(),
              },
            ],
          );
      })
      .catch((error: unknown) =>
        Alert.alert('Couldn’t change notifications', errorText(error)),
      )
      .finally(() => {
        setSaving(false);
        void queryClient.invalidateQueries({ queryKey: [origin, 'push'] });
      });
  };
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <GlyphTile glyph="bell" size={36} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={type.heading}>Push notifications</Text>
          <Text style={type.small}>
            Notifications are end-to-end encrypted for this phone. Apple only
            sees that something arrived.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Push notifications from this instance"
          value={on}
          disabled={saving || local.isLoading}
          trackColor={{ true: c.moss, false: c.rule }}
          ios_backgroundColor={c.rule}
          onValueChange={toggle}
        />
      </View>
      {problem ? (
        <Text
          accessibilityRole="alert"
          style={[type.small, { color: c.danger }]}
        >
          {problem}
        </Text>
      ) : null}
    </Card>
  );
}

export default function SettingsScreen() {
  const { origin, disconnect } = useSession();
  const [busy, setBusy] = useState(false);
  const host = origin?.replace(/^https?:\/\//, '') ?? '';
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
      {...pageScrollProps}
      style={{ flex: 1, backgroundColor: c.paper }}
      contentContainerStyle={{ paddingBottom: 32 }}
    >
      <View style={{ paddingTop: 14 }}>
        <Masthead
          eyebrow="Connected instance"
          title="Your instance"
          actions={
            <IconButton
              label="Close"
              glyph="close"
              onPress={() => router.back()}
            />
          }
        />
      </View>
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        <Card style={{ backgroundColor: c.ink, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: c.lime,
              }}
            />
            <Text style={[type.meta, { color: c.lime }]}>
              Signed in on this phone
            </Text>
          </View>
          <Text selectable style={[type.title, { color: c.card }]}>
            {host}
          </Text>
          <Button
            variant="secondary"
            glyph="browser"
            label="Open Hatch on the web"
            fullWidth
            onPress={() => {
              if (origin)
                void WebBrowser.openBrowserAsync(origin).catch(
                  (error: unknown) =>
                    Alert.alert('Couldn’t open browser', errorText(error)),
                );
            }}
          />
        </Card>
        <PushCard />
        <Card style={{ gap: 18 }}>
          {notes.map((note) => (
            <View
              key={note.title}
              style={{
                flexDirection: 'row',
                gap: 14,
                alignItems: 'flex-start',
              }}
            >
              <GlyphTile glyph={note.glyph} size={36} />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={type.heading}>{note.title}</Text>
                <Text style={type.small}>{note.detail}</Text>
              </View>
            </View>
          ))}
        </Card>
        <Button
          variant="danger"
          glyph="signOut"
          label={busy ? 'Signing out…' : 'Sign out'}
          busy={busy}
          fullWidth
          onPress={signOut}
        />
        <Button fullWidth label="Done" onPress={() => router.back()} />
      </View>
    </ScrollView>
  );
}
