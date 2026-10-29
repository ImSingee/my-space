import { Text } from 'react-native';
import { palette } from './theme';
import type { GlyphName, GlyphProps } from './glyph.types';

// Android has no SF Symbols; keep a legible text mark until it gets its own set.
const marks: Partial<Record<GlyphName, string>> = {
  plus: '+',
  chevron: '›',
  clear: '×',
  close: '×',
  send: '↑',
  up: '↑',
  down: '↓',
  refresh: '↻',
  check: '✓',
  warning: '!',
};

export function Glyph({ name, size = 18, color = palette.ink }: GlyphProps) {
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      style={{ color, fontSize: size, lineHeight: size * 1.2 }}
    >
      {marks[name] ?? '•'}
    </Text>
  );
}
