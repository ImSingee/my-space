import { describe, expect, it } from 'vitest';
import { crossingFold, foldSplit } from './fold-split';

const base = { gap: 16, minColumn: 320 };

describe('foldSplit', () => {
  it('keeps one column when two do not fit', () => {
    expect(foldSplit({ ...base, width: 440, fold: null })).toBe(null);
  });

  it('splits evenly where nothing folds', () => {
    // The outer display or a phone in landscape: no gutter to align with.
    expect(foldSplit({ ...base, width: 700, fold: null })).toEqual({
      leading: 342,
      gutter: 16,
      trailing: 342,
    });
  });

  it('puts the gutter on the fold, not the middle of the inset content', () => {
    // A vertical bar takes 70 points on the trailing edge of a 900 point
    // window: the content is 830 wide but the fold is still at 450.
    const split = foldSplit({
      ...base,
      width: 830,
      fold: { x: 450, width: 0 },
    });
    expect(split).toEqual({ leading: 442, gutter: 16, trailing: 372 });
    expect(split!.leading + base.gap / 2).toBe(450);
  });

  it('widens the gutter to cover a fold wider than the gap', () => {
    // The inner display's division is 40 points wide. The trailing column
    // starts past the fold, not one gap after the leading column.
    const fold = { x: 439.5, width: 40 };
    const split = foldSplit({ ...base, width: 835, fold })!;
    expect(split.gutter).toBe(40);
    expect(split.leading).toBe(fold.x);
    expect(split.leading + split.gutter).toBe(fold.x + fold.width);
    expect(split.leading + split.gutter + split.trailing).toBe(835);
  });

  it('mirrors for right-to-left', () => {
    expect(
      foldSplit({ ...base, width: 830, fold: { x: 380, width: 0 }, rtl: true }),
    ).toEqual({ leading: 442, gutter: 16, trailing: 372 });
  });

  it('keeps one column when the fold would leave a column too narrow', () => {
    // An even split would fit, but the fold would cross its trailing column.
    expect(
      foldSplit({ ...base, width: 668, fold: { x: 369, width: 0 } }),
    ).toBeNull();
  });
});

describe('crossingFold', () => {
  it('ignores folds outside the container and horizontal folds', () => {
    expect(
      crossingFold(
        [
          { x: 900, y: 0, width: 0, height: 600 },
          { x: 0, y: 300, width: 800, height: 0 },
        ],
        800,
      ),
    ).toBeNull();
    expect(
      crossingFold([{ x: 400, y: 0, width: 10, height: 600 }], 800),
    ).toEqual({ x: 400, width: 10 });
  });
});
