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

type WidgetModule = {
  mount: (element: HTMLElement, props?: unknown) => (() => void) | void;
};

export function WidgetCard({
  item,
  onRemove,
}: {
  item: DashboardItem;
  onRemove: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | void;
    let objectUrl: string | undefined;
    setStatus('loading');

    // Load the widget module via a Blob URL. Importing the served URL directly
    // is intercepted by the dev module pipeline; a Blob URL bypasses it and
    // works the same in production. Widgets are fully bundled, so they have no
    // relative sub-imports that would break under a blob: specifier.
    void (async () => {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const code = await res.text();
      objectUrl = URL.createObjectURL(
        new Blob([code], { type: 'text/javascript' }),
      );
      const mod: WidgetModule = await import(/* @vite-ignore */ objectUrl);
      if (cancelled || !hostRef.current) return;
      if (typeof mod.mount !== 'function') {
        throw new Error('widget does not export mount()');
      }
      cleanup = mod.mount(hostRef.current);
      setStatus('ready');
    })()
      .catch(() => {
        if (!cancelled) setStatus('error');
      })
      .finally(() => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });

    return () => {
      cancelled = true;
      if (typeof cleanup === 'function') {
        cleanup();
      }
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

      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
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
