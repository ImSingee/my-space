import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Linking, Switch, View } from 'react-native';
import { pushRegistrar, pushSupported } from '../../src/state/push-registrar';
import { useSession } from '../../src/state/session';
import { Card, Notice, errorText } from '../../src/ui/primitives';
import { GlyphTile, Group, ListRow } from '../../src/ui/rows';
import { ScrollScreen, SectionLabel } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';
import { palette as c } from '../../src/ui/theme';

/** Push switch and this phone's name on the connected instance. */
export default function NotificationSettingsScreen() {
  const { origin, api } = useSession();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const local = useQuery({
    queryKey: [origin, 'push', 'local'],
    queryFn: () => pushRegistrar.enabled(origin!),
    enabled: pushSupported && Boolean(origin),
  });
  const remote = useQuery({
    queryKey: [origin, 'push', 'device'],
    queryFn: ({ signal }) => api!.pushDevice(signal),
    enabled: Boolean(api) && local.data === true,
    // The name and state can change on the web; show them fresh here.
    staleTime: 0,
  });
  const host = origin?.replace(/^https?:\/\//, '') ?? '';
  const on = local.data === true;
  // Undefined while loading or after a failed read: neither on nor off.
  const known = local.data !== undefined;
  const device = on ? remote.data : null;
  const problem =
    remote.data === null && on
      ? 'This instance has not registered this phone yet.'
      : device && !device.enabled
        ? (device.lastError ??
          'This phone was turned off for notifications on the instance.')
        : null;

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: [origin, 'push'] });

  const toggle = (next: boolean) => {
    if (!origin || !api) return;
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
        refresh();
      });
  };

  const rename = () => {
    if (!device || !api || saving) return;
    Alert.prompt(
      'Name this phone',
      'Shown for this phone in notification settings on the instance.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          isPreferred: true,
          onPress: (value?: string) => {
            const name = value?.trim().slice(0, 80);
            if (!name || name === device.name) return;
            setSaving(true);
            void api
              .renamePushDevice(device.id, name)
              .catch((error: unknown) =>
                Alert.alert('Couldn’t rename this phone', errorText(error)),
              )
              .finally(() => {
                setSaving(false);
                refresh();
              });
          },
        },
      ],
      'plain-text',
      device.name,
    );
  };

  return (
    <ScrollScreen nested eyebrow={host} title="Notification settings">
      <View style={{ paddingHorizontal: 16 }}>
        {!pushSupported ? (
          <Notice
            title="Push needs a newer build"
            detail="This build of Hatch can’t receive push notifications. Install the latest version, then come back here."
          />
        ) : (
          <>
            <SectionLabel>Push</SectionLabel>
            <Card style={{ gap: 12 }}>
              <View
                style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}
              >
                <GlyphTile glyph="bell" size={36} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={type.heading}>Push notifications</Text>
                  <Text style={type.small}>
                    End-to-end encrypted for this phone. Apple only sees that
                    something arrived.
                  </Text>
                </View>
                <Switch
                  accessibilityLabel="Push notifications from this instance"
                  value={on}
                  disabled={saving || !known}
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
            {local.error ? (
              <View style={{ marginTop: 14 }}>
                <Notice
                  tone="danger"
                  title="Couldn’t read push settings on this phone"
                  detail={errorText(local.error)}
                  action={{
                    label: 'Try again',
                    onPress: () => void local.refetch(),
                  }}
                />
              </View>
            ) : null}
            {remote.error ? (
              <View style={{ marginTop: 14 }}>
                <Notice
                  tone="danger"
                  title="Couldn’t load this phone from the instance"
                  detail={errorText(remote.error)}
                  action={{
                    label: 'Try again',
                    onPress: () => void remote.refetch(),
                  }}
                />
              </View>
            ) : null}
            {device ? (
              <>
                <SectionLabel>This phone</SectionLabel>
                <Group>
                  <ListRow
                    title="Name on the instance"
                    detail={device.name}
                    accessibilityHint="Renames this phone on the instance"
                    onPress={rename}
                  />
                </Group>
              </>
            ) : null}
            <Text style={[type.small, { marginTop: 14, paddingHorizontal: 4 }]}>
              Which notifications reach this phone is set up with routes in
              Hatch on the web.
            </Text>
          </>
        )}
      </View>
    </ScrollScreen>
  );
}
