import {
  Fragment,
  useCallback,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  I18nManager,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { FoldProbe } from './fold-probe';
import type { FoldRect } from './fold-probe.types';
import {
  columnHalves,
  crossingFold,
  foldSplit,
  tilesPerRow,
  type Split,
} from './fold-split';

/**
 * Measures a container and splits it into two columns around the display's
 * fold (see `foldSplit`). Sizes come from the container, never the screen:
 * the same page runs on the outer and inner displays, beside another app, and
 * under a vertical bar, and any of those can change while it is open.
 */
export function useFoldSplit({
  minColumn,
  gap,
}: {
  minColumn: number;
  gap: number;
}) {
  const [width, setWidth] = useState(0);
  const [folds, setFolds] = useState<FoldRect[]>([]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const fold = crossingFold(folds, width);
  const split: Split | null = foldSplit({
    width,
    fold,
    gap,
    minColumn,
    rtl: I18nManager.isRTL,
  });
  return { onLayout, onFolds: setFolds, width, split, folded: Boolean(fold) };
}

/** A container that measures itself and the fold across it. */
export function FoldContainer({
  onLayout,
  onFolds,
  style,
  children,
}: PropsWithChildren<{
  onLayout: (event: LayoutChangeEvent) => void;
  onFolds: (folds: FoldRect[]) => void;
  style?: StyleProp<ViewStyle>;
}>) {
  return (
    <View onLayout={onLayout} style={style}>
      {children}
      {/* Last: native tabs look for a page's scroll view along first children.
          It is transparent and never takes touches. */}
      <FoldProbe onFolds={onFolds} />
    </View>
  );
}

/**
 * A list that reflows into two columns when there is room for both, the
 * second column continuing the first.
 */
export function Reflow<T>({
  items,
  render,
  minColumn = 320,
  gap = 12,
}: {
  items: readonly T[];
  /** Renders one column; the two columns share the list's shape. */
  render: (items: T[]) => ReactNode;
  minColumn?: number;
  gap?: number;
}) {
  const { onLayout, onFolds, split } = useFoldSplit({ minColumn, gap });
  const [first, second] = columnHalves(items);
  return (
    <FoldContainer
      onLayout={onLayout}
      onFolds={onFolds}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: split?.gutter ?? gap,
      }}
    >
      {split && second.length ? (
        <>
          <View style={{ width: split.leading }}>{render(first)}</View>
          <View style={{ width: split.trailing }}>{render(second)}</View>
        </>
      ) : (
        <View style={{ flex: 1 }}>{render([...items])}</View>
      )}
    </FoldContainer>
  );
}

/**
 * Two blocks side by side when both fit, otherwise the leading block above
 * the trailing one.
 */
export function Columns({
  leading,
  trailing,
  minColumn = 320,
  gap = 12,
}: {
  leading: ReactNode;
  trailing: ReactNode;
  minColumn?: number;
  gap?: number;
}) {
  const { onLayout, onFolds, split } = useFoldSplit({ minColumn, gap });
  return (
    <FoldContainer
      onLayout={onLayout}
      onFolds={onFolds}
      style={
        split
          ? {
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: split.gutter,
            }
          : undefined
      }
    >
      <View style={split ? { width: split.leading } : undefined}>
        {leading}
      </View>
      <View style={split ? { width: split.trailing } : undefined}>
        {trailing}
      </View>
    </FoldContainer>
  );
}

/**
 * Tiles in rows, starting at the leading edge. Where the display folds across
 * the grid each side of the fold gets its own tiles, mirrored around it, so a
 * row has an even count and the fold falls between tiles, not through one.
 */
export function TileGrid<T>({
  items,
  keyOf,
  render,
  minTile,
  maxPerRow,
  gap = 10,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, width: number) => ReactNode;
  minTile: number;
  /** Caps a row, for example at large text sizes. */
  maxPerRow?: number;
  gap?: number;
}) {
  const { onLayout, onFolds, width, split, folded } = useFoldSplit({
    minColumn: minTile,
    gap,
  });
  // The row cap applies to the whole row: a row capped below two tiles is
  // never split, so one tile keeps the full width.
  const cap = maxPerRow ?? Infinity;
  const halved = folded && split && cap >= 2 ? split : null;
  const halves = halved ? [halved.leading, halved.trailing] : [width];
  // Around a fold both halves use the narrower one's width: the tiles stay
  // one size and the gutter stays on the fold, while the wider side (the one
  // without a vertical bar) takes the slack as margin.
  const inner = Math.min(...halves);
  const perHalf = Math.max(
    1,
    Math.min(Math.floor(cap / halves.length), tilesPerRow(inner, minTile, gap)),
  );
  const perRow = perHalf * halves.length;
  const tile = (inner - gap * (perHalf - 1)) / perHalf;
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += perRow)
    rows.push(items.slice(index, index + perRow));
  return (
    <FoldContainer onLayout={onLayout} onFolds={onFolds} style={{ gap }}>
      {width
        ? rows.map((row) => (
            <View
              key={row.map(keyOf).join()}
              style={{ flexDirection: 'row', gap: halved?.gutter ?? gap }}
            >
              {halves.map((half, side) => {
                const part = row.slice(side * perHalf, (side + 1) * perHalf);
                return (
                  <View
                    key={side}
                    style={{
                      width: half,
                      flexDirection: 'row',
                      // Before a fold, the leading tiles end at its gutter.
                      paddingStart: side ? 0 : half - inner,
                      gap,
                    }}
                  >
                    {part.map((item) => (
                      <Fragment key={keyOf(item)}>
                        {render(item, tile)}
                      </Fragment>
                    ))}
                  </View>
                );
              })}
            </View>
          ))
        : null}
    </FoldContainer>
  );
}
