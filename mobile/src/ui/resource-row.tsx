import { Host, ListItem, Text } from '@expo/ui';
import { View } from 'react-native';
import type { ResourceRowProps } from './resource-row.types';
import { hatchPalette as c, hatchRadii } from './theme';

// The card is Hatch's layout; ListItem owns the native button, focus and hit area.
export function ResourceRow({
  title,
  detail,
  kind,
  onPress,
}: ResourceRowProps) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: hatchRadii.card,
        backgroundColor: c.card,
      }}
    >
      <Host
        colorScheme="light"
        seedColor={c.accentText}
        matchContents={{ vertical: true }}
        ignoreSafeArea="all"
      >
        <ListItem
          onPress={onPress}
          leading={
            <Text textStyle={{ color: c.accentText, fontSize: 24 }}>
              {kind === 'app' ? title.charAt(0).toUpperCase() : '↗'}
            </Text>
          }
          supportingText={
            <Text textStyle={{ color: c.muted, fontSize: 14 }}>{detail}</Text>
          }
          trailing={<Text textStyle={{ color: c.muted }}>›</Text>}
          colors={{
            containerColor: c.card,
            contentColor: c.text,
            supportingContentColor: c.muted,
          }}
        >
          <Text textStyle={{ color: c.text, fontSize: 18, fontWeight: '600' }}>
            {title}
          </Text>
        </ListItem>
      </Host>
    </View>
  );
}
