import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Code,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconClock,
  IconCopy,
  IconDatabase,
  IconDatabaseCog,
  IconDownload,
  IconHistory,
  IconKey,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconServerBolt,
  IconTrash,
  IconWebhook,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  appKvQueryOptions,
  appOpsQueryOptions,
  cronRunsQueryOptions,
} from '~queries/apps';
import type { AppKvEntryView } from '~server/apps';
import {
  deleteAppKvFn,
  deleteStorageObjectFn,
  runCronJobFn,
  setAppKvFn,
} from '~server/apps';

dayjs.extend(relativeTime);

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Recent cron-trigger history (scheduled fires + manual "Run now"), newest
// first. Distinct from the backend log stream: structured per-run rows with
// trigger, status, and duration. Mirrors the workflow Executions table.
function CronHistory({ appId }: { appId: string }) {
  const query = useQuery(cronRunsQueryOptions(appId));
  const runs = query.data ?? [];

  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap">
        <IconHistory size={16} stroke={1.8} />
        <Text fw={600} size="sm">
          Trigger history
        </Text>
        {runs.length > 0 ? (
          <Text size="xs" c="dimmed">
            {runs.length}
          </Text>
        ) : null}
      </Group>
      {query.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : runs.length === 0 ? (
        <Text size="xs" c="dimmed">
          No runs yet. Scheduled fires and manual runs will appear here.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Job</Table.Th>
              <Table.Th w={110}>Trigger</Table.Th>
              <Table.Th w={90}>Status</Table.Th>
              <Table.Th w={80}>Duration</Table.Th>
              <Table.Th w={120}>When</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((run) => (
              <Table.Tr key={run.id}>
                <Table.Td>
                  <Text size="sm" fw={500} truncate>
                    {run.jobName}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="default">
                    {run.trigger}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="xs"
                    variant="light"
                    color={run.ok ? 'teal' : 'red'}
                  >
                    {run.ok ? 'ok' : 'fail'}
                    {run.status != null ? ` ${run.status}` : ''}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {formatDuration(run.durationMs)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip
                    label={dayjs(run.createdAt).format('YYYY-MM-DD HH:mm:ss')}
                    withArrow
                    position="left"
                  >
                    <Text size="xs" c="dimmed">
                      {dayjs(run.createdAt).fromNow()}
                    </Text>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

// Flat section header: the title's status / value flows inline right after the
// label (as `meta`) instead of being pinned to the far right — there is no card
// frame to anchor a right edge against anymore.
function SectionHeader({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
}) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <Text fw={600} size="sm">
        {title}
      </Text>
      {meta}
    </Group>
  );
}

// A small, flat status indicator (not a pill badge): ember when active, muted
// otherwise.
function StatusDot({ active }: { active: boolean }) {
  return (
    <Box
      aria-hidden
      style={{
        width: 7,
        height: 7,
        flex: 'none',
        borderRadius: '50%',
        backgroundColor: active
          ? 'var(--mantine-color-ember-6)'
          : 'var(--mantine-color-gray-4)',
      }}
    />
  );
}

// Add/edit form rendered inside a modal. The key is immutable once created (it
// keys the row); a secret entry's value is never shown, so editing it requires
// typing a new value (overwrite-only).
function KvForm({ appId, entry }: { appId: string; entry?: AppKvEntryView }) {
  const qc = useQueryClient();
  const editing = Boolean(entry);
  const [key, setKey] = useState(entry?.key ?? '');
  // A secret entry's value is masked, so start blank and force a fresh value.
  const [value, setValue] = useState(
    entry && !entry.secret ? (entry.value ?? '') : '',
  );
  const [secret, setSecret] = useState(entry?.secret ?? false);

  const save = useMutation({
    mutationFn: () =>
      setAppKvFn({ data: { id: appId, key: key.trim(), value, secret } }),
    onSuccess: () => {
      toast.success(editing ? 'Updated key' : 'Added key');
      void qc.invalidateQueries(appKvQueryOptions(appId));
      modals.closeAll();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  // A new key always needs a value; editing a secret also does (it's hidden, so
  // there's nothing to keep). Editing a visible value can be left as-is.
  const valueRequired = !editing || Boolean(entry?.secret);
  const canSave = key.trim().length > 0 && (!valueRequired || value.length > 0);

  return (
    <Stack gap="sm">
      <TextInput
        label="Key"
        placeholder="api-token"
        value={key}
        onChange={(e) => setKey(e.currentTarget.value)}
        disabled={editing}
        data-autofocus={!editing}
      />
      <Textarea
        label={editing && entry?.secret ? 'New value' : 'Value'}
        placeholder={
          editing && entry?.secret
            ? 'Enter a new value to overwrite (current value is hidden)'
            : 'value'
        }
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        autosize
        minRows={2}
        maxRows={8}
        data-autofocus={editing}
      />
      <Checkbox
        label="Secret — hide the value here (overwrite-only)"
        checked={secret}
        onChange={(e) => setSecret(e.currentTarget.checked)}
      />
      <Group justify="flex-end" gap="sm">
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
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          {editing ? 'Save' : 'Add'}
        </Button>
      </Group>
    </Stack>
  );
}

// Per-app key/value store: small durable values (tokens, config) kept in the
// platform DB. The backend reads/writes via the signed KV API; this panel is for
// human management. Secret values are masked (overwrite-only).
function KvStore({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const query = useQuery(appKvQueryOptions(appId));
  const entries = query.data ?? [];

  const remove = useMutation({
    mutationFn: (key: string) => deleteAppKvFn({ data: { id: appId, key } }),
    onSuccess: () => toast.success('Deleted key'),
    onError: (error) => toast.error((error as Error).message),
    onSettled: () => {
      void qc.invalidateQueries(appKvQueryOptions(appId));
    },
  });

  const openEditor = (entry?: AppKvEntryView) =>
    modals.open({
      title: entry ? `Edit "${entry.key}"` : 'Add KV entry',
      children: <KvForm appId={appId} entry={entry} />,
    });

  const confirmDelete = (key: string) =>
    modals.openConfirmModal({
      title: 'Delete key?',
      children: (
        <Text size="sm">
          Permanently delete{' '}
          <Text span fw={600} ff="monospace">
            {key}
          </Text>
          ? This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(key),
    });

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" align="center">
        <SectionHeader
          icon={<IconKey size={16} stroke={1.8} />}
          title="Key-value store"
          meta={
            entries.length > 0 ? (
              <Text size="xs" c="dimmed">
                {entries.length}
              </Text>
            ) : null
          }
        />
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => openEditor()}
        >
          Add key
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Small per-app values (tokens, config). Your backend reads/writes them
        via the signed KV API; values marked secret are hidden here
        (overwrite-only).
      </Text>
      {query.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : entries.length === 0 ? (
        <Text size="xs" c="dimmed">
          No keys yet.
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Key</Table.Th>
              <Table.Th>Value</Table.Th>
              <Table.Th w={110}>Updated</Table.Th>
              <Table.Th w={76} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((entry) => (
              <Table.Tr key={entry.key}>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" ff="monospace" lineClamp={1}>
                      {entry.key}
                    </Text>
                    {entry.secret ? (
                      <Badge size="xs" variant="light" color="orange">
                        secret
                      </Badge>
                    ) : null}
                  </Group>
                </Table.Td>
                <Table.Td>
                  {entry.secret ? (
                    <Text size="sm" c="dimmed">
                      ••••••••
                    </Text>
                  ) : (
                    <Text size="sm" ff="monospace" lineClamp={1}>
                      {entry.value}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" truncate>
                    {dayjs(entry.updatedAt).fromNow()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} justify="flex-end" wrap="nowrap">
                    <Tooltip label="Edit" withArrow position="top">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        aria-label={`Edit ${entry.key}`}
                        onClick={() => openEditor(entry)}
                      >
                        <IconPencil size={15} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Delete" withArrow position="top">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={`Delete ${entry.key}`}
                        loading={
                          remove.isPending && remove.variables === entry.key
                        }
                        onClick={() => confirmDelete(entry.key)}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

export function OperationsPanel({
  appId,
  dbName,
  dbEnabled,
}: {
  appId: string;
  /** Provisioned database name, or null when not yet provisioned. */
  dbName?: string | null;
  /** Whether this app declares/uses a database (controls the Database row). */
  dbEnabled?: boolean;
}) {
  const qc = useQueryClient();
  const query = useQuery(appOpsQueryOptions(appId));

  const runCron = useMutation({
    mutationFn: (name: string) => runCronJobFn({ data: { id: appId, name } }),
    onSuccess: (res, name) => {
      if (res.status >= 200 && res.status < 300) {
        toast.success(`Ran "${name}" (${res.status})`);
      } else {
        toast.error(`"${name}" returned ${res.status}`);
      }
    },
    onError: (error) => toast.error((error as Error).message),
    // A manual run records a history row on BOTH paths: success returns an HTTP
    // status, but a thrown failure (backend unreachable) also writes a `manual`
    // row and rethrows into onError. Invalidate in onSettled so the new row
    // shows immediately whether the call succeeded or threw.
    onSettled: () => {
      void qc.invalidateQueries(appOpsQueryOptions(appId));
      void qc.invalidateQueries(cronRunsQueryOptions(appId));
    },
  });

  const deleteObject = useMutation({
    mutationFn: (key: string) =>
      deleteStorageObjectFn({ data: { id: appId, key } }),
    onSuccess: () => {
      toast.success('Deleted object');
      void qc.invalidateQueries(appOpsQueryOptions(appId));
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const confirmDeleteObject = (key: string) =>
    modals.openConfirmModal({
      title: 'Delete object?',
      children: (
        <Text size="sm">
          Permanently delete{' '}
          <Text span fw={600} ff="monospace">
            {key}
          </Text>{' '}
          from this app&apos;s storage? This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteObject.mutate(key),
    });

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          Operations
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  const anyEnabled =
    ops.backend.capable ||
    Boolean(dbEnabled) ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.storage.enabled ||
    ops.kv.enabled;

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Operations
      </Text>

      {!anyEnabled ? (
        <Text size="sm" c="dimmed">
          No database, backend, scheduled jobs, webhook, storage, or KV to
          manage for this app.
        </Text>
      ) : (
        <Stack gap="lg">
          {ops.backend.capable ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconServerBolt size={16} stroke={1.8} />}
                title="Backend"
                meta={
                  <Group gap={6} wrap="nowrap">
                    <StatusDot active={ops.backend.running} />
                    <Text size="xs" c="dimmed">
                      {ops.backend.running ? 'Running' : 'Idle'} ·{' '}
                      {ops.backend.mode ?? 'serverless'}
                    </Text>
                  </Group>
                }
              />
              <Text size="xs" c="dimmed">
                {ops.backend.mode === 'long-running'
                  ? 'Kept warm by the platform and restarted automatically if it exits.'
                  : 'Booted on demand for each request, then idles down.'}
              </Text>
            </Stack>
          ) : null}

          {dbEnabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconDatabase size={16} stroke={1.8} />}
                title="Database"
                meta={
                  dbName ? (
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {dbName}
                    </Text>
                  ) : (
                    <Text size="xs" c="dimmed">
                      not provisioned
                    </Text>
                  )
                }
              />
              <Text size="xs" c="dimmed">
                {dbName
                  ? 'A dedicated Postgres database for this app.'
                  : 'A Postgres database is provisioned automatically on first use.'}
              </Text>
            </Stack>
          ) : null}

          {ops.cron.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconClock size={16} stroke={1.8} />}
                title="Scheduled jobs"
              />
              {ops.cron.jobs.length === 0 ? (
                <Text size="xs" c="dimmed">
                  No cron jobs declared in the manifest.
                </Text>
              ) : (
                <Table withTableBorder verticalSpacing={6} highlightOnHover>
                  <Table.Tbody>
                    {ops.cron.jobs.map((job) => (
                      <Table.Tr key={job.name}>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {job.name}
                          </Text>
                        </Table.Td>
                        <Table.Td w={120}>
                          <Text size="xs" c="dimmed" ff="monospace">
                            {job.schedule}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap" align="center">
                            <Badge
                              size="xs"
                              variant="light"
                              color={job.method ? 'blue' : 'gray'}
                            >
                              {job.method ? 'rpc' : 'path'}
                            </Badge>
                            <Text size="xs" c="dimmed" ff="monospace" truncate>
                              {job.method ?? job.path}
                              {job.nextRun
                                ? ` · next ${dayjs(job.nextRun).fromNow()}`
                                : ''}
                            </Text>
                          </Group>
                        </Table.Td>
                        <Table.Td w={110}>
                          <Button
                            size="compact-sm"
                            variant="light"
                            leftSection={<IconPlayerPlay size={14} />}
                            loading={
                              runCron.isPending &&
                              runCron.variables === job.name
                            }
                            onClick={() => runCron.mutate(job.name)}
                          >
                            Run now
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
              <CronHistory appId={appId} />
            </Stack>
          ) : null}

          {ops.webhook.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconWebhook size={16} stroke={1.8} />}
                title="Inbound webhook"
                meta={
                  <Badge
                    size="xs"
                    variant="light"
                    color={ops.webhook.auth === 'platform' ? 'teal' : 'gray'}
                  >
                    {ops.webhook.auth === 'platform'
                      ? 'platform auth'
                      : 'no platform auth'}
                  </Badge>
                }
              />
              <Group gap={8} wrap="nowrap" align="center">
                <Code
                  block
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 'var(--mantine-font-size-xs)',
                  }}
                >
                  {ops.webhook.auth === 'platform'
                    ? `${ops.webhook.url ?? ''}?secret=${ops.webhook.secret ?? ''}`
                    : (ops.webhook.url ?? '')}
                </Code>
                <Tooltip
                  label={
                    ops.webhook.auth === 'platform'
                      ? 'Copy URL with secret'
                      : 'Copy URL'
                  }
                  withArrow
                  position="left"
                >
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Copy webhook URL"
                    onClick={() => {
                      const url =
                        ops.webhook.auth === 'platform'
                          ? `${origin}${ops.webhook.url ?? ''}?secret=${
                              ops.webhook.secret ?? ''
                            }`
                          : `${origin}${ops.webhook.url ?? ''}`;
                      copy(url);
                      toast.success('Webhook URL copied');
                    }}
                  >
                    <IconCopy size={15} />
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Text size="xs" c="dimmed">
                {ops.webhook.auth === 'platform' ? (
                  <>
                    POST here from external services. The platform verifies the
                    secret, strips it, and forwards an HMAC-signed request to
                    your backend at <Code>/__webhook</Code>.
                  </>
                ) : (
                  <>
                    Unauthenticated passthrough: the platform forwards requests
                    as-is to your backend at <Code>/__webhook</Code>. Your
                    backend must verify the caller itself.
                  </>
                )}
              </Text>
            </Stack>
          ) : null}

          {ops.storage.enabled ? (
            <Stack gap={6}>
              <SectionHeader
                icon={<IconDatabaseCog size={16} stroke={1.8} />}
                title="Storage"
                meta={
                  <Text size="xs" c="dimmed">
                    {ops.storage.objects.length} object
                    {ops.storage.objects.length === 1 ? '' : 's'}
                  </Text>
                }
              />
              {ops.storage.objects.length === 0 ? (
                <Text size="xs" c="dimmed">
                  No objects stored yet.
                </Text>
              ) : (
                <Table withTableBorder verticalSpacing={6} highlightOnHover>
                  <Table.Tbody>
                    {ops.storage.objects.map((obj) => (
                      <Table.Tr key={obj.key}>
                        <Table.Td>
                          <Text size="sm" truncate>
                            {obj.key}
                          </Text>
                        </Table.Td>
                        <Table.Td w={90}>
                          <Text size="xs" c="dimmed">
                            {formatBytes(obj.size)}
                          </Text>
                        </Table.Td>
                        <Table.Td w={120}>
                          <Text size="xs" c="dimmed" truncate>
                            {dayjs(obj.updatedAt).fromNow()}
                          </Text>
                        </Table.Td>
                        <Table.Td w={76}>
                          <Group gap={2} justify="flex-end" wrap="nowrap">
                            <Tooltip label="Download" withArrow position="top">
                              <ActionIcon
                                component="a"
                                href={`/api/apps/${appId}/storage/${encodeURIComponent(
                                  obj.key,
                                )}`}
                                download
                                variant="subtle"
                                color="gray"
                                aria-label={`Download ${obj.key}`}
                              >
                                <IconDownload size={15} />
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="Delete" withArrow position="top">
                              <ActionIcon
                                variant="subtle"
                                color="red"
                                aria-label={`Delete ${obj.key}`}
                                loading={
                                  deleteObject.isPending &&
                                  deleteObject.variables === obj.key
                                }
                                onClick={() => confirmDeleteObject(obj.key)}
                              >
                                <IconTrash size={15} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Stack>
          ) : null}

          {ops.kv.enabled ? <KvStore appId={appId} /> : null}
        </Stack>
      )}
    </Box>
  );
}
