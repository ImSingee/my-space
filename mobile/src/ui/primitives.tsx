import { useEffect, useState, type PropsWithChildren } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  View,
} from 'react-native';
import { Button } from './button';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text, type } from './text';
import { fonts, palette as c, radii } from './theme';

export { Text } from './text';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => alive && setReduced(value),
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** The Hatch mark: a lime egg. `wobble` gives loaders a gentle rock. */
export function Egg({
  size = 22,
  color = c.lime,
  wobble = false,
  outline = false,
}: {
  size?: number;
  color?: string;
  wobble?: boolean;
  outline?: boolean;
}) {
  const reduced = useReducedMotion();
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!wobble || reduced) return;
    const swing = (to: number, duration: number) =>
      Animated.timing(turn, {
        toValue: to,
        duration,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      });
    const loop = Animated.loop(
      Animated.sequence([
        swing(1, 220),
        swing(-1, 320),
        swing(0.5, 240),
        swing(0, 200),
        Animated.delay(520),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [wobble, reduced, turn]);
  const height = Math.round(size * 1.27);
  return (
    <Animated.View
      accessible={false}
      style={{
        width: size,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [
          { translateY: height / 2 },
          {
            rotate: turn.interpolate({
              inputRange: [-1, 1],
              outputRange: ['-11deg', '11deg'],
            }),
          },
          { translateY: -height / 2 },
        ],
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: outline ? 'transparent' : color,
          borderWidth: outline ? 2 / 1.27 : 0,
          borderColor: c.ink,
          transform: [{ scaleY: 1.27 }],
        }}
      />
    </Animated.View>
  );
}

export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Hatch"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <Egg size={size * 0.72} />
      <Text
        maxFontSizeMultiplier={1.4}
        style={{
          fontFamily: fonts.display,
          fontWeight: '800',
          fontSize: size,
          letterSpacing: -1,
          color: c.ink,
        }}
      >
        hatch
      </Text>
    </View>
  );
}

/** Lime highlighter stroke behind the lower half of a label. */
export function Highlight({
  active = true,
  children,
}: PropsWithChildren<{ active?: boolean }>) {
  return (
    <View style={{ alignSelf: 'flex-start' }}>
      {active ? (
        <View
          style={{
            position: 'absolute',
            left: -4,
            right: -4,
            bottom: 1,
            height: '46%',
            borderRadius: 4,
            backgroundColor: c.lime,
          }}
        />
      ) : null}
      {children}
    </View>
  );
}

export function Tag({
  label,
  tone = 'quiet',
  glyph,
}: {
  label: string;
  tone?: 'lime' | 'quiet' | 'moss' | 'danger' | 'outline';
  glyph?: GlyphName;
}) {
  const tones = {
    lime: { bg: c.lime, fg: c.ink, border: c.lime },
    quiet: { bg: c.sunken, fg: c.inkSoft, border: c.sunken },
    moss: { bg: c.moss, fg: c.onMoss, border: c.moss },
    danger: { bg: c.dangerSoft, fg: c.danger, border: c.dangerSoft },
    outline: { bg: 'transparent', fg: c.inkSoft, border: c.rule },
  }[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tones.border,
        backgroundColor: tones.bg,
      }}
    >
      {glyph ? <Glyph name={glyph} size={10} color={tones.fg} /> : null}
      <Text
        maxFontSizeMultiplier={1.6}
        style={[styles.meta, { color: tones.fg, fontSize: 11 }]}
      >
        {label}
      </Text>
    </View>
  );
}

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Notice({
  title,
  detail,
  action,
  tone = 'neutral',
}: {
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
  tone?: 'neutral' | 'danger' | 'info';
}) {
  return (
    <Card>
      <View style={styles.row}>
        <View
          style={[
            styles.noticeMark,
            {
              backgroundColor:
                tone === 'danger'
                  ? c.dangerSoft
                  : tone === 'info'
                    ? c.limeSoft
                    : c.sunken,
            },
          ]}
        >
          <Glyph
            name={tone === 'info' ? 'sparkle' : 'warning'}
            size={14}
            color={tone === 'danger' ? c.danger : c.ink}
          />
        </View>
        <Text accessibilityRole="header" style={[styles.heading, styles.grow]}>
          {title}
        </Text>
      </View>
      {detail ? (
        <Text selectable style={styles.callout}>
          {detail}
        </Text>
      ) : null}
      {action ? (
        <Button
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
          fullWidth
        />
      ) : null}
    </Card>
  );
}

export function Busy({ label = 'Loading…' }: { label?: string }) {
  return (
    <View
      style={styles.busy}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <Egg size={26} wobble />
      <Text style={[styles.meta, { color: c.inkSoft }]}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <Egg size={26} outline />
        <Egg size={34} />
        <Egg size={20} outline />
      </View>
      <Text accessibilityRole="header" style={[styles.title]}>
        {title}
      </Text>
      <Text style={[styles.callout, { maxWidth: 320 }]}>{detail}</Text>
      {action ? (
        <Button
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.paper },
  content: { padding: 20, gap: 16, paddingBottom: 40 },
  grow: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  ...type,
  card: {
    backgroundColor: c.card,
    borderRadius: radii.card,
    padding: 18,
    gap: 12,
  },
  noticeMark: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busy: {
    flex: 1,
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  empty: {
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 36,
  },
});
