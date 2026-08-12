import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  JsonInput,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTable,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { formatRelative } from '~lib/format';
import { appDataTablesQueryOptions } from '~queries/apps';
import { mutateAppDataTableFn, queryAppDataTableFn } from '~server/apps';
import { SectionHeader } from './section-header';

type Row = Record<string, unknown> & { id?: string };
type RowFields = Record<string, { optional: boolean }>;
type RowPatch = { value: Record<string, unknown>; unset: string[] };

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function changedRowFields(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
  fields: RowFields,
): RowPatch {
  const value = Object.fromEntries(
    Object.entries(edited).filter(
      ([key, value]) =>
        !Object.hasOwn(original, key) || !jsonValuesEqual(original[key], value),
    ),
  );
  const unset = Object.keys(original).filter(
    (key) => !Object.hasOwn(edited, key),
  );
  for (const key of unset) {
    const field = fields[key];
    if (!field) {
      throw new Error(
        `Field "${key}" is no longer in the Data Table schema. Reload and retry.`,
      );
    }
    if (!field.optional) {
      throw new Error(`Required field "${key}" cannot be removed.`);
    }
  }
  return { value, unset };
}

function QueryFailure({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Text size="xs" c="red">
        {error instanceof Error ? error.message : 'Failed to load Data Tables.'}
      </Text>
      <Button
        type="button"
        size="compact-xs"
        variant="light"
        color="red"
        loading={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </Group>
  );
}

function RowForm({
  appId,
  table,
  fields,
  row,
}: {
  appId: string;
  table: string;
  fields: RowFields;
  row?: Row;
}) {
  const qc = useQueryClient();
  const editable = row
    ? Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'createdAt', 'updatedAt'].includes(key),
        ),
      )
    : {};
  const [value, setValue] = useState(JSON.stringify(editable, null, 2));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(value) as Record<string, unknown>;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new Error('Row value must be a JSON object.');
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Invalid JSON';
        setError(message);
        throw cause;
      }
      let operation:
        | {
            type: 'patch';
            table: string;
            id: string;
            value: Record<string, unknown>;
            unset?: string[];
          }
        | {
            type: 'insert';
            table: string;
            value: Record<string, unknown>;
          };
      try {
        if (!row?.id) {
          operation = { type: 'insert', table, value: parsed };
        } else {
          const patch = changedRowFields(editable, parsed, fields);
          if (
            Object.keys(patch.value).length === 0 &&
            patch.unset.length === 0
          ) {
            throw new Error('No changes to save.');
          }
          operation = {
            type: 'patch',
            table,
            id: row.id,
            value: patch.value,
            ...(patch.unset.length > 0 ? { unset: patch.unset } : {}),
          };
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Invalid row';
        setError(message);
        throw cause;
      }
      return mutateAppDataTableFn({
        data: {
          id: appId,
          mutation: { operations: [operation] },
        },
      });
    },
    onSuccess: () => {
      toast.success(row ? 'Updated row' : 'Added row');
      void qc.invalidateQueries({
        queryKey: ['apps', appId, 'data-table-rows'],
      });
      void qc.invalidateQueries(appDataTablesQueryOptions(appId));
      modals.closeAll();
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : 'Failed to save row.');
    },
  });

  return (
    <Stack gap="sm">
      <JsonInput
        label="Row value"
        description="System fields are managed by the platform. Remove optional fields to clear them."
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        error={error}
        validationError="Invalid JSON"
        formatOnBlur
        autosize
        minRows={8}
        maxRows={18}
        data-autofocus
      />
      <Group justify="flex-end">
        <Button
          type="button"
          variant="default"
          onClick={() => modals.closeAll()}
        >
          Cancel
        </Button>
        <Button
          type="button"
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {row ? 'Save' : 'Add'}
        </Button>
      </Group>
    </Stack>
  );
}

export function DataTableSection({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const info = useQuery(appDataTablesQueryOptions(appId));
  const tables = useMemo(() => info.data?.tables ?? [], [info.data?.tables]);
  const [table, setTable] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [showMigrations, setShowMigrations] = useState(false);

  useEffect(() => {
    const nextTable = tables.some((item) => item.name === table)
      ? table
      : (tables[0]?.name ?? null);
    if (nextTable === table) return;
    setTable(nextTable);
    setCursor(null);
    setCursorHistory([]);
  }, [table, tables]);

  const rows = useQuery({
    queryKey: ['apps', appId, 'data-table-rows', table, cursor],
    queryFn: () =>
      queryAppDataTableFn({
        data: {
          id: appId,
          query: { table, cursor: cursor ?? undefined, limit: 50 },
        },
      }),
    enabled: Boolean(table),
  });

  const columns = useMemo(() => {
    if (!table || !info.data) return [];
    const descriptor = info.data.schema.tables[table];
    return ['id', ...Object.keys(descriptor?.fields ?? {}), 'updatedAt'];
  }, [info.data, table]);

  const remove = useMutation({
    mutationFn: (id: string) =>
      mutateAppDataTableFn({
        data: {
          id: appId,
          mutation: { operations: [{ type: 'delete', table, id }] },
        },
      }),
    onSuccess: () => {
      toast.success('Deleted row');
      void qc.invalidateQueries({
        queryKey: ['apps', appId, 'data-table-rows'],
      });
      void qc.invalidateQueries(appDataTablesQueryOptions(appId));
    },
    onError: (cause) => {
      toast.error(
        cause instanceof Error ? cause.message : 'Failed to delete row.',
      );
    },
  });

  const openEditor = (row?: Row) => {
    if (!table || !info.data) return;
    const descriptor = info.data.schema.tables[table];
    if (!descriptor) return;
    modals.open({
      title: row ? `Edit ${table} row` : `Add ${table} row`,
      size: 'lg',
      children: (
        <RowForm
          appId={appId}
          table={table}
          fields={descriptor.fields}
          row={row}
        />
      ),
    });
  };

  const confirmDelete = (row: Row) => {
    if (!row.id) return;
    modals.openConfirmModal({
      title: 'Delete row?',
      children: (
        <Text size="sm">
          Permanently delete <Code>{row.id}</Code> from <Code>{table}</Code>?
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(row.id as string),
    });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <SectionHeader
          icon={<IconTable size={16} stroke={1.8} />}
          title="Data Tables"
          meta={
            info.data ? (
              <Text size="xs" c="dimmed" ff="monospace">
                {info.data.schemaHash.slice(0, 10)}
              </Text>
            ) : null
          }
        />
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={!table}
          onClick={() => openEditor()}
        >
          Add row
        </Button>
      </Group>

      {info.isError ? (
        <QueryFailure
          error={info.error}
          retrying={info.isFetching}
          onRetry={() => void info.refetch()}
        />
      ) : null}

      {info.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : !info.data ? (
        info.isError ? null : (
          <Text size="xs" c="dimmed">
            No Data Table schema has been deployed.
          </Text>
        )
      ) : (
        <>
          <Group align="end">
            <Select
              label="Table"
              data={tables.map((item) => ({
                value: item.name,
                label: `${item.name} (~${item.rowCount})`,
              }))}
              value={table}
              onChange={(next) => {
                setTable(next);
                setCursor(null);
                setCursorHistory([]);
              }}
              allowDeselect={false}
              style={{ width: 260 }}
            />
            <Button
              type="button"
              variant="subtle"
              color="gray"
              rightSection={<IconChevronDown size={14} />}
              onClick={() => setShowMigrations((value) => !value)}
            >
              {info.data.migrations.length} migration
              {info.data.migrations.length === 1 ? '' : 's'}
            </Button>
          </Group>
          <Collapse expanded={showMigrations}>
            <Stack gap="xs">
              {info.data.migrations.map((migration) => (
                <Stack key={migration.id} gap={3}>
                  <Group gap="xs">
                    <Text size="xs" fw={600}>
                      #{migration.id}
                    </Text>
                    {migration.destructive ? (
                      <Badge size="xs" color="orange" variant="light">
                        destructive
                      </Badge>
                    ) : null}
                    <Text size="xs" c="dimmed">
                      {formatRelative(migration.appliedAt)} ·{' '}
                      {migration.schemaHash.slice(0, 10)}
                    </Text>
                  </Group>
                  <Code block>{migration.sql || '-- schema unchanged'}</Code>
                </Stack>
              ))}
            </Stack>
          </Collapse>

          {rows.isError ? (
            <QueryFailure
              error={rows.error}
              retrying={rows.isFetching}
              onRetry={() => void rows.refetch()}
            />
          ) : null}

          {rows.isLoading ? (
            <Center py="lg">
              <Loader size="sm" />
            </Center>
          ) : !rows.data ? null : rows.data.items.length === 0 ? (
            <Text size="xs" c="dimmed">
              No rows yet.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={700}>
              <Table withTableBorder verticalSpacing={6} highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {columns.map((column) => (
                      <Table.Th key={column}>{column}</Table.Th>
                    ))}
                    <Table.Th w={72} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.data?.items.map((row) => (
                    <Table.Tr key={String(row.id)}>
                      {columns.map((column) => (
                        <Table.Td key={column} maw={240}>
                          <Text size="xs" ff="monospace" truncate>
                            {typeof row[column] === 'object'
                              ? JSON.stringify(row[column])
                              : String(row[column] ?? '')}
                          </Text>
                        </Table.Td>
                      ))}
                      <Table.Td>
                        <Group gap={2} wrap="nowrap">
                          <Tooltip label="Edit" withArrow>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={`Edit ${row.id}`}
                              onClick={() => openEditor(row)}
                            >
                              <IconPencil size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete" withArrow>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={`Delete ${row.id}`}
                              onClick={() => confirmDelete(row)}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {rows.data ? (
            <Group justify="flex-end">
              <ActionIcon
                variant="default"
                aria-label="Previous page"
                disabled={cursorHistory.length === 0}
                onClick={() => {
                  const history = [...cursorHistory];
                  setCursor(history.pop() ?? null);
                  setCursorHistory(history);
                }}
              >
                <IconChevronLeft size={15} />
              </ActionIcon>
              <ActionIcon
                variant="default"
                aria-label="Next page"
                disabled={!rows.data.cursor}
                onClick={() => {
                  setCursorHistory((history) => [...history, cursor ?? '']);
                  setCursor(rows.data.cursor);
                }}
              >
                <IconChevronRight size={15} />
              </ActionIcon>
            </Group>
          ) : null}
        </>
      )}
    </Stack>
  );
}
