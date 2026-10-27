import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Glyph } from './glyph';
import type { DetailProps } from './native-controls.types';
import { Text, type } from './text';
import { fonts, palette as c } from './theme';

/** Collapsed tool, request and reasoning detail. Expands into a mono slip. */
export function Details({
  title,
  text,
  error,
  state,
}: DetailProps & { state?: 'working' | 'done' | 'failed' }) {
  const [expanded, setExpanded] = useState(false);
  const dot =
    state === 'working'
      ? c.lime
      : state === 'failed' || error
        ? c.danger
        : state === 'done'
          ? c.moss
          : c.rule;
  return (
    <View
      style={{
        borderRadius: 14,
        backgroundColor: expanded ? c.card : 'transparent',
        borderWidth: 1,
        borderColor: c.rule,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: pressed ? c.limeSoft : 'transparent',
        })}
      >
        <View
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }}
        />
        <Text
          style={[type.small, { flex: 1, color: c.ink, fontWeight: '600' }]}
          numberOfLines={2}
        >
          {title}
        </Text>
        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
          <Glyph name="chevron" size={11} color={c.inkFaint} />
        </View>
      </Pressable>
      {expanded ? (
        <View
          style={{
            margin: 8,
            marginTop: 0,
            padding: 12,
            borderRadius: 10,
            backgroundColor: c.paper,
          }}
        >
          <Text
            selectable
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              lineHeight: 18,
              color: error ? c.danger : c.inkSoft,
            }}
          >
            {text || 'No output.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
