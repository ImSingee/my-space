import { NativeTabs } from 'expo-router/native-tabs';
import { useNavigationPreferences } from '../../src/state/navigation';
import { hatchPalette } from '../../src/ui/theme';
import { tabDetails } from '../../src/ui/navigation';

export default function TabLayout() {
  const { preferences } = useNavigationPreferences();
  return (
    <NativeTabs
      tintColor={hatchPalette.accentText}
      backgroundColor={hatchPalette.background}
      disableTransparentOnScrollEdge
    >
      {preferences.order.map((id) => (
        <NativeTabs.Trigger
          key={id}
          name={id}
          hidden={!preferences.visible.includes(id)}
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
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
