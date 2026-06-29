import {
  ActionIcon,
  Card,
  Group,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAppWindow, IconGripVertical, IconX } from '@tabler/icons-react';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import type { DashboardItem } from '~server/apps';

/** Encode widget bundle source as a `data:` module URL (UTF-8 safe). */
function toModuleDataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:text/javascript;base64,${btoa(binary)}`;
}

/** Build the sandboxed document that mounts a widget bundle inside the iframe. */
function widgetFrameHtml(moduleUrl: string): string {
  // Run the widget in its own iframe document/realm instead of the dashboard
  // page: a crashing or DOM-mutating widget can no longer corrupt the dashboard,
  // and top-navigation/popups stay blocked (sandbox omits those tokens). The
  // frame stays same-origin (allow-same-origin) because widgets use the
  // documented Connect/storage clients, which need the signed-in user's
  // same-origin session to reach `/api/apps/<id>/rpc` and `/storage`.
  // NOTE: same-origin means this is a robustness/blast-radius boundary, not a
  // hard security sandbox against malicious widget code — that needs per-app
  // origins or a scoped postMessage proxy (a platform-level change, same
  // limitation as cross-app runtime isolation). `moduleUrl` is base64 (no
  // quotes / `</script`), so inlining it is safe.
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;height:100%}
body{font:14px/1.5 system-ui,-apple-system,sans-serif}
#hatch-widget-root{height:100%;overflow:auto}
</style></head><body><div id="hatch-widget-root"></div>
<script type="module">
(async () => {
  try {
    const m = await import(${JSON.stringify(moduleUrl)});
    if (typeof m.mount !== 'function') throw new Error('widget does not export mount()');
    m.mount(document.getElementById('hatch-widget-root'));
    parent.postMessage({ __hatchWidget: 'ready' }, '*');
  } catch (e) {
    parent.postMessage({ __hatchWidget: 'error', message: String((e && e.message) || e) }, '*');
  }
})();
</script></body></html>`;
}

export function WidgetCard({
  item,
  onRemove,
}: {
  item: DashboardItem;
  onRemove: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    setStatus('loading');

    // Only accept ready/error from THIS widget's frame.
    const onMessage = (event: MessageEvent) => {
      if (cancelled || event.source !== frame.contentWindow) return;
      const data = event.data as { __hatchWidget?: string } | null;
      if (!data || typeof data !== 'object') return;
      if (data.__hatchWidget === 'ready') setStatus('ready');
      else if (data.__hatchWidget === 'error') setStatus('error');
    };
    window.addEventListener('message', onMessage);

    // Fetch the (authenticated, same-origin) bundle in the host, then hand it to
    // the iframe as an inlined `data:` module. Fetching here keeps the request
    // out of the dev module pipeline (which intercepts a direct import of the
    // served URL); the widget still executes inside its own iframe document.
    void (async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const code = await res.text();
      if (cancelled) return;
      frame.srcdoc = widgetFrameHtml(toModuleDataUrl(code));
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      frame.srcdoc = '';
    };
  }, [item.url]);

  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Group
        justify="space-between"
        mb={6}
        wrap="nowrap"
        className="widget-drag-handle"
        style={{ cursor: 'grab', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconGripVertical size={15} stroke={1.6} opacity={0.4} />
          <AppGlyph name={item.appName} seed={item.appId} size="sm" />
          <Text size="sm" fw={600} truncate>
            {item.name}
          </Text>
        </Group>
        <Group gap={2} wrap="nowrap" className="widget-no-drag">
          <Tooltip label="Open app" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Open app"
              renderRoot={(props) => (
                <Link
                  to="/apps/$appId"
                  params={{ appId: item.appId }}
                  {...props}
                />
              )}
            >
              <IconAppWindow size={15} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Remove from dashboard" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Remove widget"
              onClick={onRemove}
            >
              <IconX size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <iframe
        ref={frameRef}
        title={item.name}
        // allow-scripts + allow-same-origin: scripts run and the widget keeps
        // the same-origin session its Connect/storage client needs, while the
        // omitted tokens still block top-navigation and popups. See
        // widgetFrameHtml for why this is a robustness — not hard-security —
        // boundary.
        sandbox="allow-scripts allow-same-origin"
        style={{
          flex: 1,
          minHeight: 0,
          border: 0,
          width: '100%',
          display: status === 'ready' ? 'block' : 'none',
        }}
      />
      {status === 'loading' ? (
        <Stack gap="xs" px={4} py={2} style={{ flex: 1 }}>
          <Skeleton height={26} width="55%" radius="sm" />
          <Skeleton height={11} radius="sm" />
          <Skeleton height={11} width="80%" radius="sm" />
        </Stack>
      ) : null}
      {status === 'error' ? (
        <Text size="xs" c="red" py="sm">
          Failed to load widget. Try redeploying the app.
        </Text>
      ) : null}
    </Card>
  );
}
