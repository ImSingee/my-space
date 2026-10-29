import { Pressable, View } from 'react-native';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text } from './text';
import { palette as c } from './theme';

const variants = {
  primary: { bg: c.moss, fg: c.onMoss, border: c.moss },
  secondary: { bg: c.card, fg: c.ink, border: c.rule },
  quiet: { bg: 'transparent', fg: c.moss, border: 'transparent' },
  danger: { bg: c.card, fg: c.danger, border: c.dangerSoft },
} as const;

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: keyof typeof variants;
  size?: 'large' | 'regular' | 'small';
  glyph?: GlyphName;
  disabled?: boolean;
  busy?: boolean;
  fullWidth?: boolean;
  accessibilityHint?: string;
};

// Capsule buttons: filled moss for the one primary action on a surface.
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'regular',
  glyph,
  disabled,
  busy,
  fullWidth,
  accessibilityHint,
}: ButtonProps) {
  const tone = variants[variant];
  const unavailable = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: unavailable, busy: Boolean(busy) }}
      disabled={unavailable}
      onPress={onPress}
      hitSlop={size === 'small' ? 5 : 4}
      style={({ pressed }) => ({
        minHeight: size === 'large' ? 54 : size === 'small' ? 36 : 44,
        paddingHorizontal: variant === 'quiet' ? 8 : size === 'small' ? 14 : 20,
        paddingVertical: size === 'small' ? 6 : 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.bg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
        opacity: unavailable ? 0.42 : pressed ? 0.78 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      {glyph ? (
        <Glyph name={glyph} size={size === 'small' ? 12 : 15} color={tone.fg} />
      ) : null}
      <Text
        style={{
          color: tone.fg,
          fontSize: size === 'large' ? 17 : size === 'small' ? 14 : 16,
          fontWeight: '600',
          textAlign: 'center',
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A 44pt round control for toolbar-style actions. */
export function IconButton({
  label,
  glyph,
  onPress,
  tone = 'card',
  disabled,
  size = 44,
}: {
  label: string;
  glyph: GlyphName;
  onPress: () => void;
  tone?: 'card' | 'moss' | 'ink' | 'clear' | 'lime' | 'sunken';
  disabled?: boolean;
  size?: number;
}) {
  const colors = {
    card: { bg: c.card, fg: c.ink },
    moss: { bg: c.moss, fg: c.onMoss },
    ink: { bg: c.ink, fg: c.card },
    clear: { bg: 'transparent', fg: c.inkSoft },
    lime: { bg: c.lime, fg: c.ink },
    sunken: { bg: c.sunken, fg: c.inkSoft },
  }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: Math.max(size, 44),
        height: Math.max(size, 44),
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.38 : pressed ? 0.7 : 1,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Glyph name={glyph} size={Math.round(size * 0.38)} color={colors.fg} />
      </View>
    </Pressable>
  );
}
