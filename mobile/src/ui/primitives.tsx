import type { PropsWithChildren } from 'react';
import { hatchPalette, hatchRadii } from './theme';
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
  View,
} from 'react-native';

// Refresh native text layout on Dynamic Type changes without resetting screen state.
export function Text(props: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <NativeText key={fontScale} {...props} />;
}

// Hatch uses the same light-only Ember appearance as the platform.
export function usePalette() {
  return hatchPalette;
}

export function Brand() {
  return (
    <View style={styles.row}>
      <Image
        source={require('../../../public/logo192.png')}
        accessible={false}
        style={{ width: 36, height: 36 }}
      />
      <Text
        style={{ color: hatchPalette.text, fontSize: 22, fontWeight: '600' }}
      >
        Hatch
      </Text>
    </View>
  );
}

export function PageHeading({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.pageHeading}>
      <Text accessibilityRole="header" style={styles.display}>
        {title}
      </Text>
      {detail ? (
        <Text style={[styles.body, { color: hatchPalette.muted }]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
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
    <View
      style={[
        styles.notice,
        { backgroundColor: c.panel, borderColor: c.border },
      ]}
    >
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
      {action ? <Action {...action} secondary fullWidth /> : null}
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
    <View
      style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}
    >
      {children}
    </View>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: hatchPalette.background },
  content: { padding: 20, gap: 16, paddingBottom: 36 },
  card: { borderRadius: hatchRadii.card, borderWidth: 1, padding: 16, gap: 12 },
  heading: { fontSize: 20, fontWeight: '600', letterSpacing: -0.3 },
  display: {
    fontFamily: Platform.OS === 'ios' ? 'Iowan Old Style' : 'serif',
    fontSize: 34,
    fontWeight: '500',
    letterSpacing: -0.34,
    color: hatchPalette.text,
  },
  pageHeading: {
    gap: 8,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: hatchPalette.border,
  },
  body: { fontSize: 16, lineHeight: 24 },
  caption: { fontSize: 13, lineHeight: 19 },
  label: { fontSize: 13, fontWeight: '600', letterSpacing: 0.5 },
  notice: {
    borderRadius: hatchRadii.card,
    borderWidth: 1,
    padding: 20,
    gap: 12,
  },
  busy: {
    flex: 1,
    minHeight: 140,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
