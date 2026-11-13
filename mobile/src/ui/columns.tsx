import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  I18nManager,
  useWindowDimensions,
  View,
  type ViewInstance,
} from 'react-native';
import { columnHalves, foldSplit, tilesPerRow, type Split } from './fold-split';

/**
 * Measures a container and splits it into two columns around the fold (see
 * `foldSplit`). Sizes come from the container, never the screen: the same
 * page runs on the outer and inner displays, beside another app, and under a
 * vertical bar, and any of those can change while it is open.
 */
export function useFoldSplit({
  minColumn,
  gap,
}: {
  minColumn: number;
  gap: number;
}) {
  const ref = useRef<ViewInstance>(null);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [frame, setFrame] = useState<{ x: number; width: number } | null>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, _y, width) =>
      setFrame((previous) =>
        previous && previous.x === x && previous.width === width
          ? previous
          : { x, width },
      ),
    );
  }, []);
  // A resize can move the container without changing its own layout.
  useEffect(measure, [measure, windowWidth, windowHeight]);
  const split: Split | null = frame
    ? foldSplit({
        width: frame.width,
        x: frame.x,
        windowWidth,
        gap,
        minColumn,
        rtl: I18nManager.isRTL,
      })
    : null;
  return { ref, onLayout: measure, width: frame?.width ?? 0, split };
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
  const { ref, onLayout, split } = useFoldSplit({ minColumn, gap });
  const [first, second] = columnHalves(items);
  return (
    <View
      ref={ref}
      onLayout={onLayout}
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap }}
    >
      {split && second.length ? (
        <>
          <View style={{ width: split.leading }}>{render(first)}</View>
          <View style={{ width: split.trailing }}>{render(second)}</View>
        </>
      ) : (
        <View style={{ flex: 1 }}>{render([...items])}</View>
      )}
    </View>
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
  const { ref, onLayout, split } = useFoldSplit({ minColumn, gap });
  return (
    <View
      ref={ref}
      onLayout={onLayout}
      style={
        split
          ? { flexDirection: 'row', alignItems: 'flex-start', gap }
          : undefined
      }
    >
      <View style={split ? { width: split.leading } : undefined}>
        {leading}
      </View>
      <View style={split ? { width: split.trailing } : undefined}>
        {trailing}
      </View>
    </View>
  );
}

/**
 * Tiles in rows. On a display wide enough for two columns each half of a row
 * gets its own tiles, so a row always has an even count and the fold falls
 * between tiles rather than through one.
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
  /** Caps a compact row, for example at large text sizes. */
  maxPerRow?: number;
  gap?: number;
}) {
  const { ref, onLayout, width, split } = useFoldSplit({
    minColumn: minTile,
    gap,
  });
  const halves = split ? [split.leading, split.trailing] : [width];
  // Both halves use the narrower one's width, mirrored around the fold: the
  // tiles stay one size and the gutter stays centered on the fold, while the
  // wider side (the one without a vertical bar) takes the slack as margin.
  const inner = Math.min(...halves);
  const perHalf = Math.min(
    maxPerRow ?? Infinity,
    tilesPerRow(inner, minTile, gap),
  );
  const perRow = perHalf * halves.length;
  const tile = (inner - gap * (perHalf - 1)) / perHalf;
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += perRow)
    rows.push(items.slice(index, index + perRow));
  return (
    <View ref={ref} onLayout={onLayout} style={{ gap }}>
      {width
        ? rows.map((row) => (
            <View
              key={row.map(keyOf).join()}
              style={{ flexDirection: 'row', gap }}
            >
              {halves.map((half, side) => {
                const part = row.slice(side * perHalf, (side + 1) * perHalf);
                return (
                  <View
                    key={side}
                    style={{
                      width: half,
                      flexDirection: 'row',
                      // The leading half's tiles end at the fold's gutter.
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
    </View>
  );
}
