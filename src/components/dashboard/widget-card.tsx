import { ActionIcon, Card, Group, Loader, Text, Tooltip } from '@mantine/core';
import { IconAppWindow, IconGripVertical, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import type { DashboardItem } from '~server/subapps';

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
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconGripVertical size={15} stroke={1.6} opacity={0.4} />
          <Text size="sm" fw={600} truncate>
            {item.name}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {item.subappName}
          </Text>
        </Group>
        <Group gap={2} wrap="nowrap" className="widget-no-drag">
          <Tooltip label="Open app" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              component="a"
              href={`/api/subapps/${item.subappId}/app/`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open app"
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
        <Group justify="center" py="lg" style={{ flex: 1 }}>
          <Loader size="sm" />
        </Group>
      ) : null}
      {status === 'error' ? (
        <Text size="xs" c="red" py="sm">
          Failed to load widget. Try redeploying the subapp.
        </Text>
      ) : null}
    </Card>
  );
}
