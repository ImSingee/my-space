import { baseTheme } from '../theme/base-theme';
import type { MantineThemeOverride } from '@mantine/core';

/**
 * Orange theme (inspired by `cat-reminder`).
 */
export const orangeTheme: MantineThemeOverride = {
  ...baseTheme,
  // primaryPalette: orangeColors, primaryShade: 5
  primaryShade: 5,
  colors: {
    ...baseTheme.colors,
    // secondary: "stone", secondaryPalette: stoneColors
    primary: baseTheme.colors?.orange ?? baseTheme.colors?.primary,
    secondary: baseTheme.colors?.stone ?? baseTheme.colors?.secondary,
    dark: baseTheme.colors?.stone ?? baseTheme.colors?.dark,
  },
  defaultRadius: 'lg',
  other: {
    ...baseTheme.other,
    style: 'orange',
  },
};
