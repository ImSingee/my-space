import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import {
  type Layout,
  type Layouts,
  Responsive,
  WidthProvider,
} from 'react-grid-layout';
import { BREAKPOINTS, CANONICAL_BREAKPOINT, COLS } from './dashboard-grid';
import 'react-grid-layout/css/styles.css';

const Grid = WidthProvider(Responsive);

/** Render the real responsive config at a fixed container width with two
 * half-width widgets, so we can observe whether RGL reflows them. */
function Harness({ width }: { width: number }) {
  const layout: Layout[] = [
    { i: 'a', x: 0, y: 0, w: 6, h: 2 },
    { i: 'b', x: 6, y: 0, w: 6, h: 2 },
  ];
  const layouts: Layouts = { [CANONICAL_BREAKPOINT]: layout };
  return (
    <div style={{ width }}>
      <Grid
        breakpoints={BREAKPOINTS}
        cols={COLS}
        layouts={layouts}
        rowHeight={80}
        margin={[16, 16]}
        containerPadding={[0, 0]}
        compactType="vertical"
      >
        <div key="a">A</div>
        <div key="b">B</div>
      </Grid>
    </div>
  );
}

function readItems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.react-grid-item')].map(
    (el) => {
      const match = /translate\(([\d.-]+)px,\s*([\d.-]+)px\)/.exec(
        el.style.transform,
      );
      return {
        x: match ? Number.parseFloat(match[1]) : Number.NaN,
        y: match ? Number.parseFloat(match[2]) : Number.NaN,
        width: Number.parseFloat(el.style.width),
      };
    },
  );
}

test('wide viewport keeps both widgets side by side (lg, 12 cols)', async () => {
  const { container } = await render(<Harness width={1300} />);
  await vi.waitFor(() => {
    const items = readItems(container);
    expect(items).toHaveLength(2);
    // Same row, different columns => laid out horizontally.
    expect(items[0].y).toBe(items[1].y);
    expect(items[0].x).not.toBe(items[1].x);
  });
});

test('narrow viewport reflows widgets into a single column (xxs, 2 cols)', async () => {
  const { container } = await render(<Harness width={460} />);
  // The container starts at the WidthProvider default (1280 => lg) and only
  // collapses once ResizeObserver reports the real 460px width, so poll until
  // the reflow lands.
  await vi.waitFor(() => {
    const items = readItems(container);
    expect(items).toHaveLength(2);
    // Stacked vertically: same column, different rows.
    expect(items[0].x).toBe(items[1].x);
    expect(items[0].y).not.toBe(items[1].y);
    // The w=6 widgets are capped to the 2-column grid, so each now spans the
    // full narrow container instead of half of a wide one.
    expect(items[0].width).toBeGreaterThan(400);
    expect(items[0].width).toBeLessThanOrEqual(460);
  });
});

test('canonical breakpoint maps 1:1 to the stored 12-column system', () => {
  // The server clamps stored coordinates to a 12-column grid, so the persisted
  // (canonical) breakpoint must stay at 12 columns and remain the widest one.
  expect(COLS[CANONICAL_BREAKPOINT]).toBe(12);
  const widest = Object.entries(BREAKPOINTS).sort((l, r) => r[1] - l[1])[0][0];
  expect(widest).toBe(CANONICAL_BREAKPOINT);
});
