import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, View } from 'react-native';
import { useReducedMotion } from './primitives';
import { Text, type } from './text';
import { palette as c } from './theme';

/** Typographic tabs; the selected one is struck with a lime marker. */
export function ScopeTabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      contentContainerStyle={{ gap: 22, paddingHorizontal: 20 }}
      style={{ flexGrow: 0 }}
    >
      {options.map((option) => (
        <ScopeTab
          key={option.value}
          {...option}
          active={option.value === value}
          onPress={() => onChange(option.value)}
        />
      ))}
    </ScrollView>
  );
}

function ScopeTab({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
}) {
  const reduced = useReducedMotion();
  const [stroke] = useState(() => new Animated.Value(active ? 1 : 0));
  useEffect(() => {
    const target = active ? 1 : 0;
    if (reduced) stroke.setValue(target);
    else
      Animated.timing(stroke, {
        toValue: target,
        duration: active ? 260 : 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
  }, [active, reduced, stroke]);
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={count === undefined ? label : `${label}, ${count}`}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 3 }}>
        <View>
          <Animated.View
            style={{
              position: 'absolute',
              left: -4,
              right: -4,
              bottom: 2,
              height: '44%',
              borderRadius: 4,
              backgroundColor: c.lime,
              transformOrigin: 'left',
              transform: [{ scaleX: stroke }],
            }}
          />
          <Text
            maxFontSizeMultiplier={1.6}
            style={[
              type.title,
              { fontSize: 20, color: active ? c.ink : c.inkFaint },
            ]}
          >
            {label}
          </Text>
        </View>
        {count !== undefined ? (
          <Text
            maxFontSizeMultiplier={1.6}
            style={[type.meta, { fontSize: 11, color: c.inkFaint }]}
          >
            {count}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
