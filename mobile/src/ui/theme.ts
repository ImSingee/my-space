// Native projection of DESIGN.md, base-theme.ts and ember-theme/style.css.
// Keep this dependency-free: mobile must not import the Mantine/web runtime.
export const hatchPalette = {
  dark: false,
  background: '#ffffff',
  card: '#ffffff',
  panel: '#faf8f5',
  sunken: '#f6f3ee',
  text: '#1c1917',
  muted: '#57534e',
  border: '#e7e5e4',
  accent: '#ea580c',
  // Ember 7 is the accessible text/control tint on white and warm surfaces.
  accentText: '#c2410c',
  subtle: '#fff7ed',
  danger: '#b91c1c',
} as const;

export const hatchRadii = { small: 8, card: 12, large: 16 } as const;
