import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { ResourceRow } from '../../src/ui/resource-row';
import { Screen, SectionLabel } from '../../src/ui/screen';
import { Text, usePalette } from '../../src/ui/primitives';
export default function MoreScreen() {
  const { origin } = useSession();
  const c = usePalette();
  return (
    <Screen title="More">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 32 }}
      >
        <SectionLabel>Workspace</SectionLabel>
        <ResourceRow
          title="Dashboards"
          detail="Your widgets and daily views"
          kind="dashboard"
          onPress={() =>
            router.push({ pathname: '/library', params: { kind: 'dashboard' } })
          }
        />
        <ResourceRow
          title="All apps"
          detail="Browse your full collection"
          kind="app"
          onPress={() =>
            router.push({
              pathname: '/library',
              params: { kind: 'apps', all: 'true' },
            })
          }
        />
        <ResourceRow
          title="All workflows"
          detail="Pinned and occasional automations"
          kind="workflow"
          onPress={() =>
            router.push({
              pathname: '/library',
              params: { kind: 'workflows', all: 'true' },
            })
          }
        />
        <ResourceRow
          title="Agent"
          detail="Your conversations"
          kind="conversation"
          onPress={() =>
            router.push({ pathname: '/library', params: { kind: 'agent' } })
          }
        />
        <SectionLabel>On this device</SectionLabel>
        <ResourceRow
          title="Customize navigation"
          detail="Tabs, order and start page"
          kind="settings"
          onPress={() => router.push('/navigation')}
        />
        <ResourceRow
          title="Your instance"
          detail={origin?.replace(/^https?:\/\//, '') ?? 'Not connected'}
          kind="settings"
          onPress={() => router.push('/settings')}
        />
        <View style={{ marginTop: 32, gap: 6 }}>
          <Text style={{ color: c.text, fontWeight: '600', fontSize: 16 }}>
            Hatch
          </Text>
          <Text style={{ color: c.muted, fontSize: 13 }}>
            A home for the things you make.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
