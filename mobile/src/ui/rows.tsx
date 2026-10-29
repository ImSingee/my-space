import {
  Children,
  Fragment,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text, type } from './text';
import { palette as c, pigmentFor, radii } from './theme';

export function Monogram({ name, size = 44 }: { name: string; size?: number }) {
  const letter = name.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? '•';
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        backgroundColor: pigmentFor(name),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        maxFontSizeMultiplier={1.2}
        style={[
          type.display,
          { fontSize: size * 0.5, lineHeight: size * 0.6, letterSpacing: 0 },
        ]}
      >
        {letter}
      </Text>
    </View>
  );
}

export function GlyphTile({
  glyph,
  tone = 'sunken',
  size = 40,
}: {
  glyph: GlyphName;
  tone?: 'sunken' | 'lime' | 'ink' | 'moss';
  size?: number;
}) {
  const colors = {
    sunken: { bg: c.sunken, fg: c.ink },
    lime: { bg: c.lime, fg: c.ink },
    ink: { bg: c.ink, fg: c.lime },
    moss: { bg: c.moss, fg: c.onMoss },
  }[tone];
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.32,
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Glyph name={glyph} size={size * 0.45} color={colors.fg} />
    </View>
  );
}

/** A white sheet of rows separated by hairlines. */
export function Group({ children }: PropsWithChildren) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderRadius: radii.card,
        overflow: 'hidden',
      }}
    >
      {items.map((child, index) => (
        <Fragment key={index}>
          {index ? (
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: c.rule,
                marginLeft: 16,
              }}
            />
          ) : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

export function ListRow({
  title,
  detail,
  leading,
  trailing,
  onPress,
  accessibilityHint,
}: {
  title: string;
  detail?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        rowStyles.row,
        pressed && { backgroundColor: c.limeSoft },
      ]}
    >
      {leading}
      <View style={rowStyles.text}>
        <Text style={type.heading}>{title}</Text>
        {detail ? <Text style={type.small}>{detail}</Text> : null}
      </View>
      {trailing}
      <Glyph name="chevron" size={12} color={c.inkFaint} />
    </Pressable>
  );
}

/** Editorial index entry for complete collections. */
export function IndexRow({
  index,
  title,
  detail,
  tags,
  onPress,
}: {
  index: number;
  title: string;
  detail?: string;
  tags?: ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        rowStyles.row,
        { alignItems: 'flex-start', paddingVertical: 16 },
        pressed && { backgroundColor: c.limeSoft },
      ]}
    >
      <Text
        accessible={false}
        style={[type.meta, { minWidth: 24, paddingTop: 3 }]}
      >
        {String(index).padStart(2, '0')}
      </Text>
      <View style={[rowStyles.text, { gap: 6 }]}>
        <Text style={type.heading}>{title}</Text>
        {detail ? (
          <Text style={type.small} numberOfLines={3}>
            {detail}
          </Text>
        ) : null}
        {tags ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {tags}
          </View>
        ) : null}
      </View>
      <View style={{ paddingTop: 4 }}>
        <Glyph name="chevron" size={12} color={c.inkFaint} />
      </View>
    </Pressable>
  );
}

/** A pinned shortcut: its own label and destination, even for the same App. */
export function PinTile({
  label,
  detail,
  hash,
  width,
  onPress,
}: {
  label: string;
  detail: string;
  hash?: string;
  width: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        label,
        detail.replace(/[.\s]+$/, ''),
        hash && `opens at ${hash}`,
      ]
        .filter(Boolean)
        .join(', ')}
      onPress={onPress}
      style={({ pressed }) => ({
        width,
        minHeight: 168,
        backgroundColor: pressed ? c.limeSoft : c.card,
        borderRadius: radii.card,
        padding: 16,
        gap: 12,
        justifyContent: 'space-between',
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <Monogram name={label} />
        <Glyph name="pin" size={12} color={c.inkFaint} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={[type.title, { fontSize: 18, lineHeight: 22 }]}>
          {label}
        </Text>
        <Text style={type.small} numberOfLines={2}>
          {detail}
        </Text>
        {hash ? (
          <Text
            style={[type.meta, { color: c.moss, marginTop: 4 }]}
            numberOfLines={1}
          >
            {hash.startsWith('#') ? hash : `#${hash}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  text: { flex: 1, gap: 3 },
});
