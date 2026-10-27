import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import type { TabId } from '../../src/core/navigation-preferences';
import { useNavigationPreferences } from '../../src/state/navigation';
import { useSession } from '../../src/state/session';
import { tabDetails } from '../../src/ui/navigation';
import { Tag, Wordmark } from '../../src/ui/primitives';
import { GlyphTile, Group, ListRow } from '../../src/ui/rows';
import { Screen, SectionLabel } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';

export default function MoreScreen() {
  const { origin } = useSession();
  const { preferences } = useNavigationPreferences();
  const host = origin?.replace(/^https?:\/\//, '') ?? 'Not connected';
  const open = (id: TabId) => {
    if (preferences.visible.includes(id)) router.navigate(`/(tabs)/${id}`);
    else
      router.push({
        pathname: '/library',
        params: { kind: id === 'dashboard' ? 'dashboard' : id },
      });
  };
  const start =
    preferences.defaultTab === 'more'
      ? 'More'
      : tabDetails[preferences.defaultTab].label;
  return (
    <Screen eyebrow={host} title="More">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48 }}
      >
        <SectionLabel count={preferences.order.length}>Everything</SectionLabel>
        <Group>
          {preferences.order.map((id) => {
            const inTabs = preferences.visible.includes(id);
            return (
              <ListRow
                key={id}
                title={tabDetails[id].label}
                detail={tabDetails[id].detail}
                leading={
                  <GlyphTile
                    glyph={tabDetails[id].glyph}
                    tone={inTabs ? 'sunken' : 'lime'}
                  />
                }
                trailing={
                  <Tag
                    tone={inTabs ? 'outline' : 'quiet'}
                    label={inTabs ? 'Tab' : 'Hidden'}
                  />
                }
                accessibilityHint={
                  inTabs ? 'Switches to its tab' : 'Hidden from the tab bar'
                }
                onPress={() => open(id)}
              />
            );
          })}
        </Group>
        <SectionLabel>This phone</SectionLabel>
        <Group>
          <ListRow
            title="Tabs & start page"
            detail={`Opens to ${start} · ${preferences.visible.length} of ${preferences.order.length} in the tab bar`}
            leading={<GlyphTile glyph="sliders" />}
            onPress={() => router.push('/navigation')}
          />
          <ListRow
            title="Your instance"
            detail={host}
            leading={<GlyphTile glyph="server" />}
            onPress={() => router.push('/settings')}
          />
        </Group>
        <View style={{ marginTop: 40, gap: 10, paddingHorizontal: 4 }}>
          <Wordmark size={24} />
          <Text style={type.small}>
            Small software, grown on your own server.
          </Text>
          <Text style={type.meta}>
            Version {Constants.expoConfig?.version ?? '—'}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
