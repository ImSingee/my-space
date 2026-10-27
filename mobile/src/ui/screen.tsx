import type { PropsWithChildren, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, type } from './text';
import { palette as c } from './theme';

/** Masthead page: mono eyebrow, rounded display title and round actions. */
export function Screen({
  eyebrow,
  title,
  actions,
  children,
  nested = false,
}: PropsWithChildren<{
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  nested?: boolean;
}>) {
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.paper }}
      edges={nested ? ['left', 'right'] : ['top', 'left', 'right']}
    >
      <Masthead
        eyebrow={eyebrow}
        title={title}
        actions={actions}
        nested={nested}
      />
      {children}
    </SafeAreaView>
  );
}

export function Masthead({
  eyebrow,
  title,
  actions,
  nested = false,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  nested?: boolean;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop: nested ? 4 : 14,
        paddingBottom: 14,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 12,
      }}
    >
      <View style={{ flex: 1, gap: 6 }}>
        {eyebrow ? (
          <Text style={type.meta} numberOfLines={2}>
            {eyebrow}
          </Text>
        ) : null}
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.6}
          numberOfLines={3}
          style={type.display}
        >
          {title}
        </Text>
      </View>
      {actions ? (
        <View style={{ flexDirection: 'row', gap: 4, paddingBottom: 0 }}>
          {actions}
        </View>
      ) : null}
    </View>
  );
}

/** Mono section heading with a hairline that runs to an optional count. */
export function SectionLabel({
  children,
  count,
}: PropsWithChildren<{ count?: number }>) {
  return (
    <View
      accessible
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: 22,
        marginBottom: 10,
      }}
    >
      <Text style={[type.meta, { color: c.ink }]}>{children}</Text>
      <View
        style={{
          flex: 1,
          height: StyleSheet.hairlineWidth,
          backgroundColor: c.inkFaint,
          opacity: 0.5,
        }}
      />
      {count !== undefined ? (
        <Text style={type.meta}>{String(count).padStart(2, '0')}</Text>
      ) : null}
    </View>
  );
}
