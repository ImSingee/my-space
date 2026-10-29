import type { PropsWithChildren, ReactNode } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, type } from './text';
import { palette as c } from './theme';

/**
 * Inset ownership for a page's root scroll view. On iOS UIKit adds the status
 * bar, native tab bar and home indicator to the adjusted inset, so content
 * scrolls under the glass bar yet its end stays reachable. Native tabs only
 * find a scroll view that is first in the page's view chain, which also gives
 * scroll-to-top on tab re-tap and tab-bar minimising; keep it there.
 */
export const pageScrollProps = {
  contentInsetAdjustmentBehavior: 'automatic',
  automaticallyAdjustsScrollIndicatorInsets: true,
} as const satisfies ScrollViewProps;

/**
 * Root of a scrolling page. Vertical insets belong to the scroll view on iOS
 * (see `pageScrollProps`) and to the stack header or tab bar on Android, so
 * only a top-level Android page pads its status bar here.
 */
export function PageRoot({
  nested = false,
  children,
}: PropsWithChildren<{ nested?: boolean }>) {
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.paper }}
      edges={
        Platform.OS === 'ios' || nested
          ? ['left', 'right']
          : ['top', 'left', 'right']
      }
    >
      {children}
    </SafeAreaView>
  );
}

/** Fixed page with a masthead over a non-scrolling surface (the Dashboard). */
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

/** Scrolling page: the masthead scrolls with content, like a large title. */
export function ScrollScreen({
  eyebrow,
  title,
  actions,
  nested = false,
  children,
  contentContainerStyle,
  ...scrollProps
}: PropsWithChildren<
  {
    eyebrow?: string;
    title: string;
    actions?: ReactNode;
    nested?: boolean;
  } & Omit<ScrollViewProps, 'children'>
>) {
  return (
    <PageRoot nested={nested}>
      <ScrollView
        {...pageScrollProps}
        {...scrollProps}
        style={{ flex: 1 }}
        contentContainerStyle={[{ paddingBottom: 32 }, contentContainerStyle]}
      >
        <Masthead
          eyebrow={eyebrow}
          title={title}
          actions={actions}
          nested={nested}
        />
        {children}
      </ScrollView>
    </PageRoot>
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
