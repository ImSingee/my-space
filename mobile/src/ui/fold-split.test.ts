import { describe, expect, it } from 'vitest';
import { foldSplit } from './fold-split';

const base = { gap: 16, minColumn: 320 };

describe('foldSplit', () => {
  it('keeps one column when two do not fit', () => {
    expect(foldSplit({ ...base, width: 440, x: 0, windowWidth: 440 })).toBe(
      null,
    );
  });

  it('centers the gutter on the window center, not the inset content', () => {
    // A vertical bar takes 70 points on the trailing edge of a 900 point
    // window: the content is 830 wide but the fold is still at 450.
    const split = foldSplit({ ...base, width: 830, x: 0, windowWidth: 900 });
    expect(split).toEqual({ leading: 442, trailing: 372 });
    expect(split!.leading + base.gap / 2).toBe(450);
  });

  it('accounts for a leading inset and mirrors for right-to-left', () => {
    const split = { ...base, width: 830, x: 70, windowWidth: 900 };
    expect(foldSplit(split)).toEqual({ leading: 372, trailing: 442 });
    expect(foldSplit({ ...split, rtl: true })).toEqual({
      leading: 442,
      trailing: 372,
    });
  });

  it('keeps one column when the fold would leave a column too narrow', () => {
    // The fold crosses the container 35 points right of its middle.
    expect(
      foldSplit({ ...base, width: 668, x: 16, windowWidth: 770 }),
    ).toBeNull();
  });

  it('splits evenly beside the fold', () => {
    // A container that does not span the window center, e.g. a side pane.
    expect(
      foldSplit({ ...base, width: 700, x: 700, windowWidth: 1300 }),
    ).toEqual({ leading: 342, trailing: 342 });
  });
});
