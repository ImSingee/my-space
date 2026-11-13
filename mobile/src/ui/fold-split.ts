/**
 * Column geometry that keeps the gutter on iPhone Duo's fold.
 *
 * The inner display folds at its horizontal center. When the app fills that
 * display, the window's center is the fold, but a page's content is rarely
 * centered on it: a vertical bar or other safe area sits along one edge only.
 * Splitting the content area in half would put the gutter beside the fold and
 * the fold through one column, so the split follows the window center, and a
 * container the center crosses stays one column when either side lacks room.
 * A container that does not span the center splits into two even columns.
 */
export type SplitInput = {
  /** Container width. */
  width: number;
  /** Container's left edge in window coordinates. */
  x: number;
  /** Window (scene) width. */
  windowWidth: number;
  /** Space between the two columns. */
  gap: number;
  /** Narrowest acceptable column. */
  minColumn: number;
  /** Right-to-left layout puts the leading column on the right. */
  rtl?: boolean;
};

/** Leading and trailing column widths, or `null` when one column fits best. */
export type Split = { leading: number; trailing: number };

export function foldSplit({
  width,
  x,
  windowWidth,
  gap,
  minColumn,
  rtl = false,
}: SplitInput): Split | null {
  if (!(width > 0) || width < minColumn * 2 + gap) return null;
  const center = windowWidth / 2 - x;
  let left = center - gap / 2;
  let right = width - center - gap / 2;
  if (left < minColumn || right < minColumn) {
    // A container the fold crosses keeps one column rather than put the fold
    // through a column; one beside the fold splits evenly.
    if (center > 0 && center < width) return null;
    left = (width - gap) / 2;
    right = left;
  }
  return rtl
    ? { leading: right, trailing: left }
    : { leading: left, trailing: right };
}

/** How many tiles of at least `minTile` fit side by side in `width`. */
export function tilesPerRow(width: number, minTile: number, gap: number) {
  return Math.max(1, Math.floor((width + gap) / (minTile + gap)));
}

/**
 * Splits a list for two columns read top to bottom, then leading to trailing,
 * so reading order and VoiceOver order stay those of the single column.
 */
export function columnHalves<T>(items: readonly T[]): [T[], T[]] {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}
