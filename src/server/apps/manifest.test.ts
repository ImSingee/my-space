import { describe, expect, it } from 'vitest';
import {
  normalizeManifest,
  parseSourceManifest,
  snapToSupportedSize,
} from './manifest';

describe('snapToSupportedSize', () => {
  it('returns undefined for an empty list (free-form fallback)', () => {
    expect(snapToSupportedSize([], { w: 4, h: 3 })).toBeUndefined();
  });

  it('picks the nearest footprint by grid-unit distance', () => {
    const sizes = [
      { w: 2, h: 2 },
      { w: 6, h: 6 },
    ];
    expect(snapToSupportedSize(sizes, { w: 3, h: 3 })).toEqual({ w: 2, h: 2 });
    expect(snapToSupportedSize(sizes, { w: 5, h: 5 })).toEqual({ w: 6, h: 6 });
  });

  it('breaks ties toward the first declared size', () => {
    const sizes = [
      { w: 2, h: 2 },
      { w: 4, h: 4 },
    ];
    expect(snapToSupportedSize(sizes, { w: 3, h: 3 })).toEqual({ w: 2, h: 2 });
  });
});

describe('normalizeManifest widgets', () => {
  const normalize = (widget: Record<string, unknown>) =>
    normalizeManifest(
      parseSourceManifest({
        id: 'demo',
        name: 'Demo',
        capabilities: { widgets: true },
        widgets: [{ id: 'w', name: 'W', entry: 'widgets/w.tsx', ...widget }],
      }),
    ).widgets[0];

  it('de-duplicates supportedSizes preserving author order', () => {
    const w = normalize({
      defaultSize: { w: 4, h: 3 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 4, h: 3 },
        { w: 3, h: 2 },
      ],
    });
    expect(w.supportedSizes).toEqual([
      { w: 3, h: 2 },
      { w: 4, h: 3 },
    ]);
  });

  it('snaps defaultSize into the supported set when it is not a member', () => {
    const w = normalize({
      defaultSize: { w: 5, h: 5 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 4, h: 3 },
      ],
    });
    expect(w.defaultSize).toEqual({ w: 4, h: 3 });
  });

  it('keeps a defaultSize that is already supported', () => {
    const w = normalize({
      defaultSize: { w: 3, h: 2 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 6, h: 4 },
      ],
    });
    expect(w.defaultSize).toEqual({ w: 3, h: 2 });
  });

  it('leaves supportedSizes empty (free-form) when undeclared', () => {
    const w = normalize({ defaultSize: { w: 4, h: 3 } });
    expect(w.supportedSizes).toEqual([]);
    expect(w.defaultSize).toEqual({ w: 4, h: 3 });
  });
});
