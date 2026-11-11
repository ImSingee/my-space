import {
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
} from 'react-native';
import { fonts, palette as c } from './theme';

// Refresh native text layout on Dynamic Type changes without resetting screen state.
export function Text(props: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <NativeText key={fontScale} {...props} />;
}

/** Rounded display, system text and uppercase mono metadata. */
export const type = StyleSheet.create({
  display: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 39,
    fontWeight: '800',
    letterSpacing: -0.9,
    color: c.ink,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: c.ink,
  },
  heading: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    letterSpacing: -0.2,
    color: c.ink,
  },
  body: { fontSize: 16, lineHeight: 23, color: c.ink },
  callout: { fontSize: 15, lineHeight: 21, color: c.inkSoft },
  small: { fontSize: 13, lineHeight: 18, color: c.inkSoft },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: c.inkFaint,
  },
});
