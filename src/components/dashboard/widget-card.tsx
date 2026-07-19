import {
  ActionIcon,
  Card,
  Group,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAppWindow,
  IconGripVertical,
  IconRefresh,
  IconX,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import type { DashboardItem } from '~server/dashboards';
import {
  WIDGET_CHANNEL,
  toModuleDataUrl,
  widgetFrameHtml,
} from './widget-frame';

export function WidgetCard({
  item,
  onRemove,
  refreshSignal = 0,
}: {
  item: DashboardItem;
  onRemove: () => void;
  /**
   * Monotonic counter bumped by dashboard-wide manual and automatic refreshes.
   * Each new value posts a `refresh` message to a ready widget; the initial
   * value is ignored so a freshly mounted widget isn't refreshed redundantly.
   */
  refreshSignal?: number;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [refreshSupported, setRefreshSupported] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSupportedRef = useRef(false);
  const refreshingRef = useRef(false);
  const activeRefreshRequestRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const frameGenerationRef = useRef<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  // Read the latest grid units inside the (url-keyed) load effect without
  // rebuilding the frame when only the size changes — those go down as `units`
  // messages instead, so a resize never reloads the widget.
  const unitsRef = useRef({ w: item.w, h: item.h });
  unitsRef.current = { w: item.w, h: item.h };

  // Fetch the (authenticated, same-origin) bundle in the host, then hand it to
  // the iframe as an inlined `data:` module. Fetching here keeps the request
  // out of the dev module pipeline (which intercepts a direct import of the
  // served URL); the widget still executes inside its own iframe document.
  // useQuery dedupes concurrent mounts of the same widget and paints instantly
  // from cache, while the default staleTime (0) still revalidates on every
  // mount — the URL is stable across redeploys, so a longer staleTime would
  // serve a stale bundle right after a deploy. The reload effect below keys on
  // the code string itself, so a revalidation that returns unchanged code
  // never reloads the frame (string deps compare by value); only a genuinely
  // new bundle does. Focus refetches stay off so a mounted widget is not
  // reloaded just by switching windows.
  const bundle = useQuery({
    queryKey: ['widget-bundle', item.url],
    queryFn: async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    refetchOnWindowFocus: false,
  });
  const code = bundle.data;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const generation = crypto.randomUUID();
    frameGenerationRef.current = generation;
    setStatus('loading');
    refreshSupportedRef.current = false;
    refreshingRef.current = false;
    activeRefreshRequestRef.current = null;
    setRefreshSupported(false);
    setRefreshing(false);
    if (code === undefined) {
      return () => {
        if (frameGenerationRef.current === generation) {
          frameGenerationRef.current = null;
        }
      };
    }

    let cancelled = false;

    // Only accept lifecycle messages from this frame's current srcdoc load.
    const onMessage = (event: MessageEvent) => {
      if (cancelled || event.source !== frame.contentWindow) return;
      const data = event.data as {
        [WIDGET_CHANNEL]?: string;
        generation?: string;
        requestId?: string;
        supported?: boolean;
      } | null;
      if (!data || typeof data !== 'object' || data.generation !== generation) {
        return;
      }
      if (data[WIDGET_CHANNEL] === 'ready') {
        setStatus('ready');
        // Re-sync grid units after every mount. This also covers a bundle
        // replacement that remounts the iframe after the placement was resized.
        frame.contentWindow?.postMessage(
          {
            [WIDGET_CHANNEL]: 'units',
            generation,
            w: unitsRef.current.w,
            h: unitsRef.current.h,
          },
          '*',
        );
      } else if (data[WIDGET_CHANNEL] === 'refresh-capability') {
        const supported = data.supported === true;
        refreshSupportedRef.current = supported;
        setRefreshSupported(supported);
      } else if (
        data[WIDGET_CHANNEL] === 'refresh-complete' &&
        data.requestId === activeRefreshRequestRef.current
      ) {
        activeRefreshRequestRef.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
      } else if (data[WIDGET_CHANNEL] === 'error') {
        activeRefreshRequestRef.current = null;
        refreshingRef.current = false;
        setRefreshing(false);
        setStatus('error');
      }
    };
    window.addEventListener('message', onMessage);
    frame.srcdoc = widgetFrameHtml(
      toModuleDataUrl(code),
      unitsRef.current,
      generation,
    );

    return () => {
      cancelled = true;
      if (frameGenerationRef.current === generation) {
        frameGenerationRef.current = null;
      }
      refreshSupportedRef.current = false;
      refreshingRef.current = false;
      activeRefreshRequestRef.current = null;
      window.removeEventListener('message', onMessage);
      frame.srcdoc = '';
    };
  }, [code]);

  const effectiveStatus = bundle.isError ? 'error' : status;

  // Push grid-unit changes (a resize that lands new w/h) to the running widget
  // without reloading it. Pixel size is measured inside the frame, so it needs
  // no host message. Re-sends on ready too, in case w/h changed mid-load.
  useEffect(() => {
    if (status !== 'ready') return;
    const generation = frameGenerationRef.current;
    if (!generation) return;
    frameRef.current?.contentWindow?.postMessage(
      { [WIDGET_CHANNEL]: 'units', generation, w: item.w, h: item.h },
      '*',
    );
  }, [item.w, item.h, status]);

  // Ask a refresh-capable widget to refetch in place. The request id ties the
  // loading state to this exact refresh, and the ref prevents manual, global,
  // and automatic triggers from overlapping for the same widget.
  const requestRefresh = useCallback(() => {
    if (
      statusRef.current !== 'ready' ||
      !refreshSupportedRef.current ||
      refreshingRef.current
    ) {
      return;
    }

    const target = frameRef.current?.contentWindow;
    const generation = frameGenerationRef.current;
    if (!target || !generation) return;

    refreshSequenceRef.current += 1;
    const requestId = `${item.id}:${refreshSequenceRef.current}`;
    activeRefreshRequestRef.current = requestId;
    refreshingRef.current = true;
    setRefreshing(true);
    target.postMessage(
      { [WIDGET_CHANNEL]: 'refresh', generation, requestId },
      '*',
    );
  }, [item.id]);

  // Fan a dashboard-wide manual or automatic refresh out to this widget. Skip
  // the first run so a freshly mounted card isn't refreshed immediately.
  // requestRefresh reads the live status/capability refs, so unsupported or
  // busy widgets are skipped.
  const refreshMounted = useRef(false);
  useEffect(() => {
    if (!refreshMounted.current) {
      refreshMounted.current = true;
      return;
    }
    requestRefresh();
  }, [refreshSignal, requestRefresh]);

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
          {refreshSupported || refreshing ? (
            <Tooltip label={refreshing ? 'Refreshing' : 'Refresh'} withArrow>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Refresh widget"
                aria-busy={refreshing}
                loading={refreshing}
                disabled={effectiveStatus !== 'ready'}
                onClick={requestRefresh}
              >
                <IconRefresh size={15} />
              </ActionIcon>
            </Tooltip>
          ) : null}
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

      {/* The iframe stays laid out under any loading/error overlay so the
          widget's in-frame ResizeObserver measures its real pixel size from the
          first mount (a display:none frame would report 0x0 until shown). */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <iframe
          ref={frameRef}
          title={item.name}
          // allow-scripts + allow-same-origin: scripts run and the widget keeps
          // the same-origin session its Connect client needs, while the
          // omitted tokens still block top-navigation and popups. See
          // widgetFrameHtml for why this is a robustness — not hard-security —
          // boundary.
          sandbox="allow-scripts allow-same-origin"
          style={{
            display: 'block',
            border: 0,
            width: '100%',
            height: '100%',
            visibility: effectiveStatus === 'ready' ? 'visible' : 'hidden',
          }}
        />
        {effectiveStatus === 'loading' ? (
          <Stack
            gap="xs"
            px={4}
            py={2}
            style={{ position: 'absolute', inset: 0 }}
          >
            <Skeleton height={26} width="55%" radius="sm" />
            <Skeleton height={11} radius="sm" />
            <Skeleton height={11} width="80%" radius="sm" />
          </Stack>
        ) : null}
        {effectiveStatus === 'error' ? (
          <Text
            size="xs"
            c="red"
            py="sm"
            style={{ position: 'absolute', inset: 0 }}
          >
            Failed to load widget. Try redeploying the app.
          </Text>
        ) : null}
      </div>
    </Card>
  );
}
