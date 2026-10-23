import { ScrollView, View } from 'react-native';
import { useNavigationPreferences } from '../src/state/navigation';
import {
  defaultNavigation,
  type TabId,
} from '../src/core/navigation-preferences';
import { Action, Notice, Text, styles, usePalette } from '../src/ui/primitives';
import { OptionToggle, Choice } from '../src/ui/native-controls';
import { tabDetails } from '../src/ui/navigation';
import { SectionLabel } from '../src/ui/screen';
export default function NavigationSettings() {
  const { preferences: p, save, saving, error } = useNavigationPreferences();
  const c = usePalette();
  const move = (id: TabId, offset: number) => {
    const order = [...p.order];
    const from = order.indexOf(id);
    const to = from + offset;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    void save({ ...p, order });
  };
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: 24, paddingBottom: 48 }}
    >
      <Text style={[styles.body, { color: c.muted }]}>
        Make Hatch feel like yours. These settings stay on this device.
      </Text>
      {error ? <Notice title="Settings weren’t saved" detail={error} /> : null}
      <SectionLabel>Open Hatch to</SectionLabel>
      <Choice
        label="Start page"
        value={p.defaultTab}
        options={[
          ...p.order
            .filter((id) => p.visible.includes(id))
            .map((id) => ({ label: tabDetails[id].label, value: id })),
          { label: 'More', value: 'more' },
        ]}
        disabled={saving}
        onChange={(value) =>
          void save({ ...p, defaultTab: value as TabId | 'more' })
        }
      />
      <SectionLabel>Tabs & order</SectionLabel>
      {p.order.map((id, index) => (
        <View
          key={id}
          style={{
            paddingVertical: 12,
            borderBottomWidth: 0.5,
            borderColor: c.border,
            gap: 4,
          }}
        >
          <OptionToggle
            label={tabDetails[id].label}
            selected={p.visible.includes(id)}
            unavailable={saving}
            onChange={() =>
              void save({
                ...p,
                visible: p.visible.includes(id)
                  ? p.visible.filter((tab) => tab !== id)
                  : [...p.visible, id],
              })
            }
          />
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              gap: 16,
            }}
          >
            <Action
              secondary
              compact
              label="Move up"
              disabled={saving || index === 0}
              onPress={() => move(id, -1)}
            />
            <Action
              secondary
              compact
              label="Move down"
              disabled={saving || index === p.order.length - 1}
              onPress={() => move(id, 1)}
            />
          </View>
        </View>
      ))}
      <View style={{ paddingVertical: 20, gap: 8 }}>
        <Text style={{ color: c.text, fontSize: 17, fontWeight: '600' }}>
          More stays at the end
        </Text>
        <Text style={[styles.caption, { color: c.muted }]}>
          Hidden tabs are still available in More. If you hide your start page,
          Hatch opens the first visible tab.
        </Text>
      </View>
      <Action
        secondary
        fullWidth
        label="Restore default navigation"
        disabled={saving}
        onPress={() => void save(defaultNavigation)}
      />
    </ScrollView>
  );
}
