import { expect, test, vi } from 'vitest';
import {
  WIDGET_CHANNEL,
  toModuleDataUrl,
  widgetFrameHtml,
} from './widget-frame';

const FRAME_GENERATION = 'frame-generation';

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

const BROKEN_WIDGET = `
export function mount() {
  throw new Error('broken mount');
}`;

// Keeps one refresh Promise pending until the host sends a resolve/reject
// control message. This lets tests prove completion is tied to real work.
const CONTROLLED_WIDGET = `
export function mount(el, context) {
  let pending;
  parent.postMessage({ t: 'mount', size: context.size }, '*');
  context.onRefresh(() => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    parent.postMessage({ t: 'refresh-pending' }, '*');
  }));
  window.addEventListener('message', (event) => {
    if (event.source !== parent || !pending) return;
    if (event.data?.t === 'resolve-refresh') {
      pending.resolve();
      pending = undefined;
    } else if (event.data?.t === 'reject-refresh') {
      pending.reject(new Error('refresh failed'));
      pending = undefined;
    }
  });
}`;

// Registers two callbacks so the capability and all-listeners semantics can be
// asserted independently from the single-listener lifecycle.
const MULTI_REFRESH_WIDGET = `
export function mount(el, context) {
  let resolveAsync;
  parent.postMessage({ t: 'mount', size: context.size }, '*');
  context.onRefresh(() => {
    parent.postMessage({ t: 'refresh-sync' }, '*');
  });
  context.onRefresh(() => new Promise((resolve) => {
    resolveAsync = resolve;
    parent.postMessage({ t: 'refresh-async' }, '*');
  }));
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.t !== 'resolve-async') return;
    resolveAsync?.();
    resolveAsync = undefined;
  });
}`;

const REMOVABLE_REFRESH_WIDGET = `
export function mount(el, context) {
  const removeFirst = context.onRefresh(() => {});
  const removeSecond = context.onRefresh(() => {});
  parent.postMessage({ t: 'mount', size: context.size }, '*');
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    if (event.data?.t === 'remove-first') {
      removeFirst();
      parent.postMessage({ t: 'removed-first' }, '*');
    } else if (event.data?.t === 'remove-second') {
      removeSecond();
      parent.postMessage({ t: 'removed-second' }, '*');
    }
  });
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
  generation: string = FRAME_GENERATION,
) {
  const container = document.createElement('div');
  container.style.cssText = `width:${width}px;height:${height}px`;
  document.body.appendChild(container);

  const events: SizeEvent[] = [];
  const refreshes: { t: 'refresh' }[] = [];
  const messages: Record<string, unknown>[] = [];
  const onMessage = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return;
    messages.push(data);
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
  iframe.srcdoc = widgetFrameHtml(
    toModuleDataUrl(module),
    { w, h },
    generation,
  );

  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    container.remove();
  };
  return { container, iframe, events, refreshes, messages, cleanup };
}

function protocolMessages(
  messages: Record<string, unknown>[],
  type: string,
): Record<string, unknown>[] {
  return messages.filter((message) => message[WIDGET_CHANNEL] === type);
}

test('widget mount receives inlined grid units and measured pixel size', async () => {
  const { events, messages, cleanup } = mountReporter(300, 200, 4, 3);
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
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'ready')).toContainEqual(
        expect.objectContaining({ generation: FRAME_GENERATION }),
      ),
    );
  } finally {
    cleanup();
  }
});

test('widget errors report their frame generation', async () => {
  const { messages, cleanup } = mountReporter(300, 200, 4, 3, BROKEN_WIDGET);
  try {
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'error')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          message: 'broken mount',
        }),
      ),
    );
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
      {
        [WIDGET_CHANNEL]: 'units',
        generation: FRAME_GENERATION,
        w: 6,
        h: 2,
      },
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

test('sync onRefresh completes each request with its request id', async () => {
  const { iframe, events, refreshes, messages, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
  );
  try {
    await vi.waitFor(() =>
      expect(events.some((e) => e.t === 'mount')).toBe(true),
    );
    expect(protocolMessages(messages, 'refresh-capability')).toEqual([
      expect.objectContaining({
        generation: FRAME_GENERATION,
        supported: true,
      }),
    ]);
    expect(refreshes).toHaveLength(0);

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'sync-1',
      },
      '*',
    );
    await vi.waitFor(() => {
      expect(refreshes.length).toBe(1);
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'sync-1',
          success: true,
        }),
      );
    });

    // Refresh is a repeatable signal, not a one-shot.
    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'sync-2',
      },
      '*',
    );
    await vi.waitFor(() => {
      expect(refreshes.length).toBe(2);
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'sync-2',
          success: true,
        }),
      );
    });
  } finally {
    cleanup();
  }
});

test('refresh with the wrong generation is ignored', async () => {
  const { iframe, events, refreshes, messages, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
  );
  try {
    await vi.waitFor(() =>
      expect(events.some((event) => event.t === 'mount')).toBe(true),
    );

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: 'stale-generation',
        requestId: 'stale-refresh',
      },
      '*',
    );
    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'current-refresh',
      },
      '*',
    );

    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'current-refresh',
          success: true,
        }),
      ),
    );
    expect(refreshes).toHaveLength(1);
    expect(
      protocolMessages(messages, 'refresh-complete').some(
        (message) => message.requestId === 'stale-refresh',
      ),
    ).toBe(false);
  } finally {
    cleanup();
  }
});

test('first onRefresh registration declares support and last removal clears it', async () => {
  const { iframe, events, messages, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
    REMOVABLE_REFRESH_WIDGET,
  );
  try {
    await vi.waitFor(() =>
      expect(events.some((event) => event.t === 'mount')).toBe(true),
    );
    expect(protocolMessages(messages, 'refresh-capability')).toEqual([
      expect.objectContaining({
        generation: FRAME_GENERATION,
        supported: true,
      }),
    ]);

    iframe.contentWindow?.postMessage({ t: 'remove-first' }, '*');
    await vi.waitFor(() =>
      expect(messages.some((message) => message.t === 'removed-first')).toBe(
        true,
      ),
    );
    expect(protocolMessages(messages, 'refresh-capability')).toEqual([
      expect.objectContaining({
        generation: FRAME_GENERATION,
        supported: true,
      }),
    ]);

    iframe.contentWindow?.postMessage({ t: 'remove-second' }, '*');
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-capability')).toEqual([
        expect.objectContaining({
          generation: FRAME_GENERATION,
          supported: true,
        }),
        expect.objectContaining({
          generation: FRAME_GENERATION,
          supported: false,
        }),
      ]),
    );
  } finally {
    cleanup();
  }
});

test('async onRefresh settles before completion and reports rejection', async () => {
  const { iframe, events, messages, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
    CONTROLLED_WIDGET,
  );
  try {
    await vi.waitFor(() =>
      expect(events.some((event) => event.t === 'mount')).toBe(true),
    );

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'resolve-me',
      },
      '*',
    );
    await vi.waitFor(() =>
      expect(messages.some((message) => message.t === 'refresh-pending')).toBe(
        true,
      ),
    );
    expect(
      protocolMessages(messages, 'refresh-complete').some(
        (message) => message.requestId === 'resolve-me',
      ),
    ).toBe(false);

    iframe.contentWindow?.postMessage({ t: 'resolve-refresh' }, '*');
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'resolve-me',
          success: true,
        }),
      ),
    );

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'reject-me',
      },
      '*',
    );
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => message.t === 'refresh-pending'),
      ).toHaveLength(2),
    );
    iframe.contentWindow?.postMessage({ t: 'reject-refresh' }, '*');
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'reject-me',
          success: false,
        }),
      ),
    );
  } finally {
    cleanup();
  }
});

test('refresh waits for every registered callback', async () => {
  const { iframe, events, messages, cleanup } = mountReporter(
    300,
    200,
    4,
    3,
    MULTI_REFRESH_WIDGET,
  );
  try {
    await vi.waitFor(() =>
      expect(events.some((event) => event.t === 'mount')).toBe(true),
    );
    expect(protocolMessages(messages, 'refresh-capability')).toEqual([
      expect.objectContaining({
        generation: FRAME_GENERATION,
        supported: true,
      }),
    ]);

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'all-listeners',
      },
      '*',
    );
    await vi.waitFor(() => {
      expect(messages.some((message) => message.t === 'refresh-sync')).toBe(
        true,
      );
      expect(messages.some((message) => message.t === 'refresh-async')).toBe(
        true,
      );
    });
    expect(
      protocolMessages(messages, 'refresh-complete').some(
        (message) => message.requestId === 'all-listeners',
      ),
    ).toBe(false);

    iframe.contentWindow?.postMessage({ t: 'resolve-async' }, '*');
    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'all-listeners',
          success: true,
        }),
      ),
    );
  } finally {
    cleanup();
  }
});

test('refresh never reloads a widget without an onRefresh handler', async () => {
  const { iframe, events, messages, cleanup } = mountReporter(
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
    expect(protocolMessages(messages, 'refresh-capability')).toHaveLength(0);

    iframe.contentWindow?.postMessage(
      {
        [WIDGET_CHANNEL]: 'refresh',
        generation: FRAME_GENERATION,
        requestId: 'unsupported',
      },
      '*',
    );

    await vi.waitFor(() =>
      expect(protocolMessages(messages, 'refresh-complete')).toContainEqual(
        expect.objectContaining({
          generation: FRAME_GENERATION,
          requestId: 'unsupported',
          success: false,
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.filter((event) => event.t === 'mount')).toHaveLength(1);
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
