import { NativeTabs } from 'expo-router/native-tabs';
import { useNavigationPreferences } from '../../src/state/navigation';
import { glyphs } from '../../src/ui/glyph.types';
import { palette as c } from '../../src/ui/theme';
import { tabDetails } from '../../src/ui/navigation';

export default function TabLayout() {
  const { preferences } = useNavigationPreferences();
  return (
    <NativeTabs
      tintColor={c.moss}
      iconColor={{ default: c.inkFaint, selected: c.moss }}
      labelStyle={{
        default: { fontWeight: '600', color: c.inkFaint },
        selected: { fontWeight: '700', color: c.moss },
      }}
      minimizeBehavior="onScrollDown"
    >
      {preferences.order.map((id) => (
        <NativeTabs.Trigger
          key={id}
          name={id}
          hidden={!preferences.visible.includes(id)}
          contentStyle={{ backgroundColor: c.paper }}
        >
          <NativeTabs.Trigger.Label>
            {tabDetails[id].label}
          </NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={tabDetails[id].icon}
            md={tabDetails[id].androidIcon}
          />
        </NativeTabs.Trigger>
      ))}
      <NativeTabs.Trigger
        name="more"
        contentStyle={{ backgroundColor: c.paper }}
      >
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={glyphs.more} md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
