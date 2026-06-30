/**
 * Shared contract between the dashboard host (`widget-card.tsx`) and the
 * sandboxed bootstrap that runs inside each widget iframe. Kept in its own
 * module (no React/DOM-host imports) so the protocol can be unit-tested against
 * a real iframe without rendering the whole dashboard.
 */

/** postMessage tag for every host<->widget-frame message. */
export const WIDGET_CHANNEL = '__hatchWidget';

/** The size handed to a widget: grid units (w/h) plus live pixel dimensions. */
export type WidgetSize = {
  /** Dashboard grid column span the widget was placed at. */
  w: number;
  /** Dashboard grid row span the widget was placed at. */
  h: number;
  /** Rendered content width in CSS pixels. */
  width: number;
  /** Rendered content height in CSS pixels. */
  height: number;
};

/** Encode a widget bundle as a `data:` module URL (UTF-8 safe). */
export function toModuleDataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/**
 * Build the sandboxed document that mounts a widget bundle inside the iframe.
 *
 * The bootstrap calls `mount(element, context)` where `context` exposes the
 * widget's current {@link WidgetSize}, an `onResize` subscription, and an
 * `onRefresh` subscription:
 * - grid units (`w`/`h`) are inlined here and refreshed by `units` messages
 *   the host posts when the placement changes;
 * - pixel dimensions are measured in-frame with a ResizeObserver, so they stay
 *   accurate across responsive reflows without the host measuring anything;
 * - `onRefresh` callbacks run when the host posts a `refresh` message (a
 *   per-widget or dashboard-wide refresh), letting a widget refetch its data
 *   in place without a remount; a widget that registers none is reloaded
 *   instead, so the host's refresh control always does something.
 *
 * `moduleUrl` is a base64 `data:` URL (no quotes / `</script`), so inlining it
 * is safe.
 */
export function widgetFrameHtml(
  moduleUrl: string,
  initialUnits: { w: number; h: number },
): string {
  const units = JSON.stringify({
    w: Math.round(initialUnits.w),
    h: Math.round(initialUnits.h),
  });
  const channel = JSON.stringify(WIDGET_CHANNEL);
  // Run the widget in its own iframe document/realm instead of the dashboard
  // page: a crashing or DOM-mutating widget can no longer corrupt the dashboard,
  // and top-navigation/popups stay blocked (sandbox omits those tokens). The
  // frame stays same-origin (allow-same-origin) because widgets use the
  // documented Connect/storage clients, which need the signed-in user's
  // same-origin session to reach `/api/apps/<id>/rpc` and `/storage`.
  // NOTE: same-origin means this is a robustness/blast-radius boundary, not a
  // hard security sandbox against malicious widget code — that needs per-app
  // origins or a scoped postMessage proxy (a platform-level change, same
  // limitation as cross-app runtime isolation).
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;height:100%}
body{font:14px/1.5 system-ui,-apple-system,sans-serif}
#hatch-widget-root{height:100%;overflow:auto}
</style></head><body><div id="hatch-widget-root"></div>
<script type="module">
(async () => {
  const channel = ${channel};
  try {
    const el = document.getElementById('hatch-widget-root');
    let units = ${units};
    let px = { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight) };
    let size = { w: units.w, h: units.h, width: px.width, height: px.height };
    const listeners = new Set();
    const refreshListeners = new Set();
    const same = (a, b) =>
      a.w === b.w && a.h === b.h && a.width === b.width && a.height === b.height;
    const recompute = () => {
      const next = { w: units.w, h: units.h, width: px.width, height: px.height };
      if (same(size, next)) return;
      size = next;
      for (const cb of listeners) {
        try { cb(size); } catch (e) {}
      }
    };
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0] && entries[0].contentRect;
      if (!rect) return;
      px = { width: Math.round(rect.width), height: Math.round(rect.height) };
      recompute();
    });
    ro.observe(el);
    window.addEventListener('message', (event) => {
      if (event.source !== parent) return;
      const data = event.data;
      if (!data) return;
      if (data[channel] === 'units') {
        units = { w: Number(data.w), h: Number(data.h) };
        recompute();
      } else if (data[channel] === 'refresh') {
        const runRefresh = () => {
          if (refreshListeners.size === 0) return false;
          for (const cb of refreshListeners) {
            try { cb(); } catch (e) {}
          }
          return true;
        };
        if (!runRefresh()) {
          // No handler registered yet. React widgets register onRefresh from an
          // effect that runs after mount() returned (and after we posted
          // 'ready'), so give late registrations a tick before falling back to a
          // full re-mount. The srcdoc + inlined data: module persist across the
          // reload; the host re-sends current units on the new 'ready' so the
          // remounted widget can't keep stale grid units.
          setTimeout(() => {
            if (!runRefresh()) location.reload();
          }, 60);
        }
      }
    });
    const context = {
      get size() { return size; },
      onResize(cb) {
        if (typeof cb !== 'function') return () => {};
        listeners.add(cb);
        try { cb(size); } catch (e) {}
        return () => { listeners.delete(cb); };
      },
      onRefresh(cb) {
        if (typeof cb !== 'function') return () => {};
        refreshListeners.add(cb);
        return () => { refreshListeners.delete(cb); };
      },
    };
    const m = await import(${JSON.stringify(moduleUrl)});
    if (typeof m.mount !== 'function') throw new Error('widget does not export mount()');
    m.mount(el, context);
    parent.postMessage({ [channel]: 'ready' }, '*');
  } catch (e) {
    parent.postMessage({ [channel]: 'error', message: String((e && e.message) || e) }, '*');
  }
})();
</script></body></html>`;
}
