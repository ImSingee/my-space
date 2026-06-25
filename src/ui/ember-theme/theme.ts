import { baseTheme } from '../theme/base-theme';
import type { MantineThemeOverride } from '@mantine/core';

/**
 * Ember theme: warm-editorial.
 *
 * A tuned terracotta accent over warm stone neutrals. Warmth is carried by the
 * accent, the stone ink/borders and the serif display type (see
 * `ember-theme/style.css`), never by a sand-tinted body background.
 */
export const emberTheme: MantineThemeOverride = {
  ...baseTheme,
  primaryShade: { light: 6, dark: 6 },
  // Show a focus ring for keyboard users (base theme disables it entirely).
  focusRing: 'auto',
  defaultRadius: 'md',
  colors: {
    ...baseTheme.colors,
    primary: baseTheme.colors?.ember ?? baseTheme.colors?.primary,
    secondary: baseTheme.colors?.stone ?? baseTheme.colors?.secondary,
    dark: baseTheme.colors?.stone ?? baseTheme.colors?.dark,
  },
  other: {
    ...baseTheme.other,
    style: 'ember',
  },
};
