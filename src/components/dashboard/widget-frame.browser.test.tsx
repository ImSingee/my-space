import { expect, test, vi } from 'vitest';
import {
  WIDGET_CHANNEL,
  toModuleDataUrl,
  widgetFrameHtml,
} from './widget-frame';

// A minimal widget module that reports the size it is handed at mount and on
// every onResize callback, so the test can assert the host<->frame contract.
const REPORTER_WIDGET = `
export function mount(el, context) {
  parent.postMessage({ t: 'mount', size: context.size }, '*');
  const off = context.onResize((size) => {
    parent.postMessage({ t: 'resize', size }, '*');
  });
  return () => off();
}`;

type SizeEvent = {
  t: 'mount' | 'resize';
  size: { w: number; h: number; width: number; height: number };
};

function mountReporter(width: number, height: number, w: number, h: number) {
  const container = document.createElement('div');
  container.style.cssText = `width:${width}px;height:${height}px`;
  document.body.appendChild(container);

  const events: SizeEvent[] = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as SizeEvent | null;
    if (data && (data.t === 'mount' || data.t === 'resize')) events.push(data);
  };
  window.addEventListener('message', onMessage);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'border:0;width:100%;height:100%';
  container.appendChild(iframe);
  iframe.srcdoc = widgetFrameHtml(toModuleDataUrl(REPORTER_WIDGET), { w, h });

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    container.remove();
  };
  return { container, iframe, events, cleanup };
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
