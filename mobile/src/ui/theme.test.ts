import { describe, expect, it } from 'vitest';
import { palette as c, pigments } from './theme';

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(a: string, b: string) {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}

describe('mobile readable color contract', () => {
  it.each([c.paper, c.card, c.sunken, c.lime, c.limeSoft])(
    'keeps body, secondary, meta, action and error text readable on %s',
    (surface) => {
      for (const ink of [c.ink, c.inkSoft, c.inkFaint, c.moss, c.danger]) {
        expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('keeps filled action and message labels readable', () => {
    expect(contrast(c.onMoss, c.moss)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.card, c.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.lime, c.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.danger, c.dangerSoft)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(pigments)('keeps monogram ink readable on %s', (pigment) => {
    expect(contrast(c.ink, pigment)).toBeGreaterThanOrEqual(4.5);
  });
});
