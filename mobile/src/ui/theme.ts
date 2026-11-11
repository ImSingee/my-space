// Field Guide: the native app's own light visual system. Pale sage paper,
// green-black ink, moss for actions and a lime highlighter for live, pinned
// and selected states. Keep this dependency-free and independent of the web UI.
export const palette = {
  paper: '#EDF0E8',
  card: '#FFFFFF',
  sunken: '#E2E6DC',
  rule: '#D3D9CC',
  ink: '#111A14',
  inkSoft: '#465049',
  inkFaint: '#5B665E',
  moss: '#1D5C3A',
  lime: '#D4F264',
  limeSoft: '#EEF9C8',
  danger: '#B42318',
  dangerSoft: '#FBE7E4',
  onMoss: '#FFFFFF',
} as const;

// Specimen pigments for monogram tiles. Ink text is readable on every one.
export const pigments = [
  '#D4F264',
  '#BFE5C8',
  '#C5E2F0',
  '#DAD3F4',
  '#EFE3B0',
  '#F3D0D6',
] as const;

export function pigmentFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return pigments[Math.abs(hash) % pigments.length];
}

export const radii = { chip: 10, tile: 18, card: 22, sheet: 28 } as const;

export const fonts = {
  display: 'ui-rounded',
  mono: 'ui-monospace',
} as const;
