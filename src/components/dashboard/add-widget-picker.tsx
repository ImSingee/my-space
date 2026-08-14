import {
  Button,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { type AvailableWidget, type DashboardItem } from '~server/dashboards';
import classes from './add-widget-picker.module.css';

export function AddWidgetPicker({
  available,
  placed,
  opened,
  onOpenedChange,
  onAdd,
  disabled = false,
}: {
  available: AvailableWidget[];
  placed: DashboardItem[];
  opened: boolean;
  onOpenedChange: (opened: boolean) => void;
  onAdd: (widget: AvailableWidget) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const placedKeys = useMemo(
    () => new Set(placed.map((item) => `${item.appId}:${item.widgetId}`)),
    [placed],
  );
  const remaining = useMemo(
    () =>
      available.filter(
        (widget) => !placedKeys.has(`${widget.appId}:${widget.widgetId}`),
      ),
    [available, placedKeys],
  );
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return remaining;
    return remaining.filter((widget) =>
      `${widget.name} ${widget.appName}`.toLocaleLowerCase().includes(term),
    );
  }, [remaining, search]);

  const setOpened = (next: boolean) => {
    if (!next) setSearch('');
    onOpenedChange(next);
  };

  const add = (widget: AvailableWidget) => {
    onAdd(widget);
    setSearch('');
    onOpenedChange(false);
  };

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="bottom-end"
      width={320}
      shadow="md"
      withArrow
      trapFocus
      returnFocus
    >
      <Popover.Target>
        <Button
          type="button"
          variant="default"
          leftSection={<IconPlus size={16} stroke={1.8} />}
          disabled={disabled || remaining.length === 0}
          onClick={() => setOpened(!opened)}
        >
          Add widget
        </Button>
      </Popover.Target>
      <Popover.Dropdown p="xs">
        <Stack gap="xs">
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            leftSection={<IconSearch size={15} stroke={1.8} />}
            placeholder="Search widgets"
            aria-label="Search widgets"
          />
          <ScrollArea.Autosize mah={300} offsetScrollbars>
            <Stack gap={2}>
              {filtered.length > 0 ? (
                filtered.map((widget) => (
                  <UnstyledButton
                    key={`${widget.appId}:${widget.widgetId}`}
                    type="button"
                    className={classes.option}
                    onClick={() => add(widget)}
                  >
                    <Group gap="sm" wrap="nowrap">
                      <AppGlyph
                        name={widget.appName}
                        seed={widget.appId}
                        size="sm"
                      />
                      <div className={classes.optionText}>
                        <Text size="sm" fw={600} truncate>
                          {widget.name}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {widget.appName}
                        </Text>
                      </div>
                    </Group>
                  </UnstyledButton>
                ))
              ) : (
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  No matching widgets
                </Text>
              )}
            </Stack>
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
