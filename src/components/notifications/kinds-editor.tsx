import {
  ActionIcon,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';

export type KindDraft = { kind: string; name: string; description: string };

export const EMPTY_KIND: KindDraft = { kind: '', name: '', description: '' };

export const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** First problem with a kind list, or null when it can be saved. */
export function kindsError(kinds: KindDraft[]): string | null {
  if (kinds.length === 0) return 'Declare at least one kind.';
  const seen = new Set<string>();
  for (const entry of kinds) {
    if (!KIND_PATTERN.test(entry.kind)) {
      return `"${entry.kind || '(empty)'}" is not a valid kind id. Use lowercase letters, digits, ".", "_" or "-".`;
    }
    if (!entry.name.trim()) return `Give kind "${entry.kind}" a display name.`;
    if (seen.has(entry.kind)) return `Kind "${entry.kind}" is listed twice.`;
    seen.add(entry.kind);
  }
  return null;
}

export function toKindInput(kinds: KindDraft[]) {
  return kinds.map((entry) => ({
    kind: entry.kind.trim(),
    name: entry.name.trim(),
    ...(entry.description.trim()
      ? { description: entry.description.trim() }
      : {}),
  }));
}

/** Edit the notification kinds a Channel declares. */
export function KindsEditor({
  value,
  onChange,
}: {
  value: KindDraft[];
  onChange: (value: KindDraft[]) => void;
}) {
  const update = (index: number, patch: Partial<KindDraft>) =>
    onChange(
      value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        Kinds
      </Text>
      <Text size="xs" c="dimmed">
        Callers must send one of these kind ids. Routes can match on them.
      </Text>
      {value.map((entry, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            placeholder="deploy.failed"
            aria-label="Kind id"
            value={entry.kind}
            onChange={(event) =>
              update(index, { kind: event.currentTarget.value.toLowerCase() })
            }
            ff="monospace"
            style={{ flex: 1 }}
          />
          <TextInput
            placeholder="Deploy failed"
            aria-label="Kind name"
            value={entry.name}
            onChange={(event) =>
              update(index, { name: event.currentTarget.value })
            }
            style={{ flex: 1 }}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            mt={6}
            aria-label="Remove kind"
            disabled={value.length === 1}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <IconTrash size={16} stroke={1.6} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        variant="subtle"
        size="xs"
        leftSection={<IconPlus size={14} stroke={1.8} />}
        onClick={() => onChange([...value, EMPTY_KIND])}
        w="fit-content"
      >
        Add kind
      </Button>
    </Stack>
  );
}
