import type { PropsWithChildren, ReactNode } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, styles, usePalette } from './primitives';

export function Screen({
  title,
  subtitle,
  action,
  children,
  nested = false,
}: PropsWithChildren<{
  title: string;
  subtitle?: string;
  action?: ReactNode;
  nested?: boolean;
}>) {
  const c = usePalette();
  return (
    <SafeAreaView
      style={styles.screen}
      edges={nested ? ['left', 'right'] : ['top', 'left', 'right']}
    >
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 12,
          paddingBottom: 16,
          gap: 5,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              fontSize: 32,
              fontWeight: '700',
              letterSpacing: -0.7,
              color: c.text,
              flexShrink: 1,
            }}
          >
            {title}
          </Text>
          {action}
        </View>
        {subtitle ? (
          <Text style={{ color: c.muted, fontSize: 15, lineHeight: 21 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {children}
    </SafeAreaView>
  );
}
export function SectionLabel({ children }: PropsWithChildren) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: usePalette().muted,
        fontSize: 14,
        fontWeight: '600',
        marginTop: 20,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}
