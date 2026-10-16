import type { PropsWithChildren } from 'react';
import {
  ActivityIndicator,
  Platform,
  PlatformColor,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';

// Refresh native text layout on Dynamic Type changes without resetting screen state.
export function Text(props: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <NativeText key={fontScale} {...props} />;
}

export function usePalette() {
  const dark = useColorScheme() === 'dark';
  return {
    dark,
    background:
      Platform.OS === 'ios'
        ? PlatformColor('systemGroupedBackground')
        : dark
          ? '#101214'
          : '#F4F5F7',
    card:
      Platform.OS === 'ios'
        ? PlatformColor('secondarySystemGroupedBackground')
        : dark
          ? '#1B1E22'
          : '#FFFFFF',
    text:
      Platform.OS === 'ios'
        ? PlatformColor('label')
        : dark
          ? '#F4F6F8'
          : '#15191E',
    muted:
      Platform.OS === 'ios'
        ? PlatformColor('secondaryLabel')
        : dark
          ? '#A4ACB8'
          : '#647080',
    border:
      Platform.OS === 'ios'
        ? PlatformColor('separator')
        : dark
          ? '#343A44'
          : '#DEE3EA',
    accent:
      Platform.OS === 'ios'
        ? PlatformColor('systemBlue')
        : dark
          ? '#9FC4FF'
          : '#245BB2',
    subtle:
      Platform.OS === 'ios'
        ? PlatformColor('tertiarySystemFill')
        : dark
          ? '#25334B'
          : '#E7EFFC',
    danger:
      Platform.OS === 'ios'
        ? PlatformColor('systemRed')
        : dark
          ? '#FF9A9A'
          : '#B52D35',
  };
}

export { Action } from './native-controls';
import { Action } from './native-controls';

export function Notice({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
}) {
  const c = usePalette();
  return (
    <View style={[styles.notice, { backgroundColor: c.card }]}>
      <Text
        accessibilityRole="header"
        style={[styles.heading, { color: c.text }]}
      >
        {title}
      </Text>
      {detail ? (
        <Text selectable style={[styles.body, { color: c.muted }]}>
          {detail}
        </Text>
      ) : null}
      {action ? <Action {...action} secondary /> : null}
    </View>
  );
}

export function Busy({ label = 'Loading…' }: { label?: string }) {
  const c = usePalette();
  return (
    <View style={styles.busy}>
      <ActivityIndicator color={c.accent} />
      <Text style={{ color: c.muted }}>{label}</Text>
    </View>
  );
}

export function Card({ children }: PropsWithChildren) {
  const c = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: c.card }]}>{children}</View>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';
}

export const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 20, gap: 16, paddingBottom: 36 },
  card: { borderRadius: 20, padding: 18, gap: 12 },
  heading: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  body: { fontSize: 16, lineHeight: 24 },
  caption: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 13, fontWeight: '600', letterSpacing: 0.5 },
  notice: { margin: 20, borderRadius: 20, padding: 22, gap: 14 },
  busy: {
    flex: 1,
    minHeight: 140,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
