import { expect, test, vi } from 'vitest';
import {
  WIDGET_CHANNEL,
  toModuleDataUrl,
  widgetFrameHtml,
} from './widget-frame';

// A minimal widget module that reports the size it is handed at mount and on
// every onResize callback, plus a beat whenever onRefresh fires, so the test can
// assert the full host<->frame contract.
const REPORTER_WIDGET = `
export function mount(el, context) {
  parent.postMessage({ t: 'mount', size: context.size }, '*');
  const off = context.onResize((size) => {
    parent.postMessage({ t: 'resize', size }, '*');
  });
  const offRefresh = context.onRefresh(() => {
    parent.postMessage({ t: 'refresh' }, '*');
  });
  return () => { off(); offRefresh(); };
}`;

// A widget that ignores context entirely (the legacy / opt-out shape). Reports
// a mount beat so a test can detect a re-mount, but registers no onRefresh.
const NOOP_WIDGET = `
export function mount(el, context) {
  parent.postMessage({ t: 'mount', size: context.size }, '*');
}`;

type SizeEvent = {
  t: 'mount' | 'resize';
  size: { w: number; h: number; width: number; height: number };
};

function mountReporter(
  width: number,
  height: number,
  w: number,
  h: number,
  module: string = REPORTER_WIDGET,
) {
  const container = document.createElement('div');
  container.style.cssText = `width:${width}px;height:${height}px`;
  document.body.appendChild(container);

  const events: SizeEvent[] = [];
  const refreshes: { t: 'refresh' }[] = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { t?: string } | null;
    if (!data) return;
    if (data.t === 'mount' || data.t === 'resize') {
      events.push(data as SizeEvent);
    } else if (data.t === 'refresh') {
      refreshes.push({ t: 'refresh' });
    }
  };
  window.addEventListener('message', onMessage);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'border:0;width:100%;height:100%';
  container.appendChild(iframe);
  iframe.srcdoc = widgetFrameHtml(toModuleDataUrl(module), { w, h });

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    container.remove();
  };
  return { container, iframe, events, refreshes, cleanup };
}

test('widget mount receives inlined grid units and measured pixel size', async () => {
  const { events, cleanup } = mountReporter(300, 200, 4, 3);
  try {
    await vi.waitFor(() => {
      const mounted = events.find((e) => e.t === 'mount');
      expect(mounted).toBeTruthy();
      expect(mounted?.size.w).toBe(4);
      expect(mounted?.size.h).toBe(3);
      // Pixel size is measured in-frame, so it reflects the real container.
      expect(mounted?.size.width).toBeGreaterThan(250);
      expect(mounted?.size.width).toBeLessThanOrEqual(300);
      expect(mounted?.size.height).toBeGreaterThan(150);
      expect(mounted?.size.height).toBeLessThanOrEqual(200);
    });
  } finally {
    cleanup();
  }
});

test('host units message updates grid units without changing pixels', async () => {
  const { iframe, events, cleanup } = mountReporter(300, 200, 4, 3);
  try {
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'mount')).toBe(true),
    );

    iframe.contentWindow?.postMessage(
      { [WIDGET_CHANNEL]: 'units', w: 6, h: 2 },
      '*',
    );

    await vi.waitFor(() => {
      const latest = events.filter((e) => e.t === 'resize').at(-1);
      expect(latest?.size.w).toBe(6);
      expect(latest?.size.h).toBe(2);
      // Pixels stay put; only the grid units changed.
      expect(latest?.size.width).toBeGreaterThan(250);
    });
  } finally {
    cleanup();
  }
});

test('host refresh message invokes the widget onRefresh handler each time', async () => {
  const { iframe, events, refreshes, cleanup } = mountReporter(300, 200, 4, 3);
  try {
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'mount')).toBe(true),
    );
    expect(refreshes).toHaveLength(0);

    iframe.contentWindow?.postMessage({ [WIDGET_CHANNEL]: 'refresh' }, '*');
    await vi.waitFor(() => expect(refreshes.length).toBe(1));

    // Refresh is a repeatable signal, not a one-shot.
    iframe.contentWindow?.postMessage({ [WIDGET_CHANNEL]: 'refresh' }, '*');
    await vi.waitFor(() => expect(refreshes.length).toBe(2));
  } finally {
    cleanup();
  }
});

test('refresh re-mounts a widget that registers no onRefresh handler', async () => {
  const { iframe, events, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
    NOOP_WIDGET,
  );
  try {
    await vi.waitFor(() =>
      expect(events.filter((e) => e.t === 'mount')).toHaveLength(1),
    );

    // With no in-widget handler, the host's refresh falls back to a reload,
    // which re-runs the bootstrap and mounts the module again.
    iframe.contentWindow?.postMessage({ [WIDGET_CHANNEL]: 'refresh' }, '*');

    await vi.waitFor(() =>
      expect(events.filter((e) => e.t === 'mount').length).toBeGreaterThan(1),
    );
  } finally {
    cleanup();
  }
});

test('resizing the frame updates the measured pixel size', async () => {
  const { container, events, cleanup } = mountReporter(300, 200, 4, 3);
  try {
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'mount')).toBe(true),
    );

    container.style.width = '520px';

    await vi.waitFor(() => {
      const latest = events.filter((e) => e.t === 'resize').at(-1);
      expect(latest?.size.width).toBeGreaterThan(480);
      // Grid units are unaffected by a pixel resize.
      expect(latest?.size.w).toBe(4);
    });
  } finally {
    cleanup();
  }
});
