import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconPlus,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type {
  ApiKeySummary,
  CreatedApiKey,
  CreateApiKeyInput,
} from '~auth/api-key-contract';
import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_MAX_LIFETIME_DAYS,
} from '~auth/api-key-contract';
import { formatRelative } from '~lib/format';
import {
  apiKeysQueryOptions,
  createApiKey,
  revokeApiKey,
} from '~queries/api-keys';
import classes from './api-keys-panel.module.css';

const DAY_SECONDS = 86_400;
const EXPIRING_SOON_DAYS = 7;
const DATE_FORMAT = 'MMM D, YYYY';

const EXPIRATION_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'custom', label: 'Custom date' },
  { value: 'never', label: 'No expiration' },
];
const DEFAULT_EXPIRATION = '30';
const CALENDAR_ARIA_LABELS = {
  monthLevelControl: 'Choose month',
  yearLevelControl: 'Choose year',
  nextMonth: 'Next month',
  previousMonth: 'Previous month',
  nextYear: 'Next year',
  previousYear: 'Previous year',
  nextDecade: 'Next decade',
  previousDecade: 'Previous decade',
};
const REVOKE_MUTATION_KEY = ['auth', 'api-keys', 'revoke'];

/** Which dismissal gestures the create dialog accepts in each step. */
type CreatePhase = 'editing' | 'creating' | 'created';

export function ApiKeysPanel() {
  const queryClient = useQueryClient();
  const keys = useQuery(apiKeysQueryOptions);
  const [createOpened, setCreateOpened] = useState(false);
  const [createPhase, setCreatePhase] = useState<CreatePhase>('editing');
  const [createFlowId, setCreateFlowId] = useState(0);

  const revoke = useMutation({
    networkMode: 'always',
    retry: false,
    mutationKey: REVOKE_MUTATION_KEY,
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData(apiKeysQueryOptions.queryKey, (current) =>
        current?.filter((key) => key.id !== id),
      );
      toast.success('API key revoked');
    },
    // Failures are toasted by the global mutation handler; refetch so a key
    // already revoked elsewhere disappears instead of lingering.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: apiKeysQueryOptions.queryKey,
      }),
  });
  const revokingIds = useMutationState({
    filters: { mutationKey: REVOKE_MUTATION_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as string,
  });

  const openCreate = () => {
    // A fresh flow per opening: reopening during the close transition must
    // never bring back a previously revealed key.
    setCreateFlowId((id) => id + 1);
    setCreatePhase('editing');
    setCreateOpened(true);
  };

  const closeCreate = () => {
    if (createPhase !== 'creating') setCreateOpened(false);
  };

  const confirmRevoke = (key: ApiKeySummary) =>
    modals.openConfirmModal({
      title: `Revoke ${key.name}?`,
      centered: true,
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Anything using <Code>{maskedIdentifier(key)}</Code> — like the Hatch
            CLI or a script — loses access immediately.
          </Text>
          <Text size="sm">
            The key is deleted permanently and can’t be restored.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Revoke key', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => revoke.mutate(key.id),
    });

  return (
    <Stack gap="md">
      <Group
        justify="space-between"
        align="flex-start"
        wrap="nowrap"
        className={classes.header}
      >
        <Stack gap={2}>
          <Text fw={600}>API keys</Text>
          <Text size="sm" c="dimmed">
            Let the Hatch CLI and your scripts build and manage Apps and
            Workflows on your behalf.
          </Text>
        </Stack>
        <Button
          type="button"
          leftSection={<IconPlus size={16} stroke={1.8} />}
          onClick={openCreate}
          className={classes.addButton}
        >
          Create API key
        </Button>
      </Group>

      {keys.isPending ? (
        <ApiKeysSkeleton />
      ) : keys.isError ? (
        <Alert
          icon={<IconAlertCircle size={18} />}
          title="API keys could not be loaded"
          color="red"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{keys.error.message}</Text>
            <Button
              type="button"
              size="xs"
              variant="light"
              color="red"
              loading={keys.isFetching}
              onClick={() => void keys.refetch()}
            >
              Try again
            </Button>
          </Stack>
        </Alert>
      ) : keys.data.length > 0 ? (
        <ul className={classes.list} aria-label="API keys">
          {keys.data.map((key) => (
            <ApiKeyRow
              key={key.id}
              apiKey={key}
              revoking={revokingIds.includes(key.id)}
              onRevoke={() => confirmRevoke(key)}
            />
          ))}
        </ul>
      ) : (
        <div className={classes.empty}>
          <ThemeIcon variant="light" size={42} radius="xl">
            <IconTerminal2 size={21} stroke={1.7} />
          </ThemeIcon>
          <Stack gap={2} align="center">
            <Text size="sm" fw={600}>
              No API keys yet
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              Create one to use the Hatch CLI or automate deployments.
            </Text>
          </Stack>
        </div>
      )}

      <Modal
        opened={createOpened}
        onClose={closeCreate}
        title={createPhase === 'created' ? 'Copy your API key' : 'New API key'}
        centered
        // A revealed key is shown only once, so only deliberate actions may
        // dismiss it; nothing can dismiss the dialog mid-request.
        closeOnEscape={createPhase === 'editing'}
        closeOnClickOutside={createPhase === 'editing'}
        closeButtonProps={{
          'aria-label': 'Close',
          disabled: createPhase === 'creating',
        }}
      >
        {/* Mantine unmounts the body once the dialog has closed, discarding
            the form and the one-time secret held in this subtree's state. */}
        <CreateApiKeyFlow
          key={createFlowId}
          onPhaseChange={setCreatePhase}
          onCancel={closeCreate}
          onDone={() => setCreateOpened(false)}
        />
      </Modal>
    </Stack>
  );
}

function ApiKeyRow({
  apiKey,
  revoking,
  onRevoke,
}: {
  apiKey: ApiKeySummary;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const expiry = expiryStatus(apiKey.expiresAt);

  return (
    <li className={classes.row}>
      <Group
        gap="sm"
        wrap="nowrap"
        align="flex-start"
        className={classes.identity}
      >
        <ThemeIcon
          variant="light"
          color={expiry.expired ? 'gray' : undefined}
          size="lg"
          radius="md"
        >
          <IconTerminal2 size={18} stroke={1.7} />
        </ThemeIcon>
        <Stack gap={4} miw={0} flex={1}>
          <Group gap={8} wrap="nowrap" miw={0}>
            <Text size="sm" fw={600} truncate>
              {apiKey.name}
            </Text>
            {expiry.badge && (
              <Badge
                size="sm"
                variant="light"
                color={expiry.expired ? 'red' : 'amber'}
                className={classes.badge}
              >
                {expiry.badge}
              </Badge>
            )}
          </Group>
          <Code className={classes.identifier}>{maskedIdentifier(apiKey)}</Code>
          <div className={classes.metaClip}>
            <Text size="xs" c="dimmed" className={classes.meta}>
              <span>Created {dayjs(apiKey.createdAt).format(DATE_FORMAT)}</span>
              <span>{expiry.label}</span>
              <span>
                {apiKey.lastRequest
                  ? `Last used ${formatRelative(apiKey.lastRequest)}`
                  : 'Never used'}
              </span>
            </Text>
          </div>
        </Stack>
      </Group>

      <Tooltip label="Revoke">
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={`Revoke ${apiKey.name}`}
          loading={revoking}
          onClick={onRevoke}
          className={classes.revoke}
        >
          <IconTrash size={17} stroke={1.7} />
        </ActionIcon>
      </Tooltip>
    </li>
  );
}

function CreateApiKeyFlow({
  onPhaseChange,
  onCancel,
  onDone,
}: {
  onPhaseChange: (phase: CreatePhase) => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [expiration, setExpiration] = useState(DEFAULT_EXPIRATION);
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const inFlight = useRef(false);

  const create = useMutation({
    // Credentials must fail now when offline, never replay on reconnection.
    networkMode: 'always',
    retry: false,
    // Failures are shown inline next to the form instead of as a toast.
    meta: { errorToast: false },
    mutationFn: async (input: CreateApiKeyInput) => {
      const result = await createApiKey(input);
      // Hand the one-time secret straight to component memory and resolve
      // with nothing, so the mutation cache never holds it.
      setCreated(result);
      onPhaseChange('created');
    },
    onError: () => onPhaseChange('editing'),
    onSettled: () => {
      inFlight.current = false;
      return queryClient.invalidateQueries({
        queryKey: apiKeysQueryOptions.queryKey,
      });
    },
  });

  if (created) return <RevealedApiKey created={created} onDone={onDone} />;

  const trimmedName = name.trim();
  const nameError = trimmedName ? null : 'Enter a name for this key';
  const dateError =
    expiration === 'custom' && !customDate ? 'Choose an expiration date' : null;
  const today = dayjs();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setShowErrors(true);
    if (nameError || dateError) return;

    inFlight.current = true;
    onPhaseChange('creating');
    create.mutate({
      name: trimmedName,
      expiresIn: lifetimeSeconds(expiration, customDate),
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          The key can build, deploy, and manage every App and Workflow through
          the CLI. It can’t manage users, credentials, or other API keys.
        </Text>
        <TextInput
          label="Name"
          placeholder="Laptop CLI"
          description="Helps you recognize where this key is used."
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          maxLength={API_KEY_NAME_MAX_LENGTH}
          error={showErrors ? nameError : null}
          readOnly={create.isPending}
          autoComplete="off"
          withAsterisk
          data-autofocus
        />
        <Stack gap={6}>
          <Select
            label="Expiration"
            data={EXPIRATION_OPTIONS}
            value={expiration}
            onChange={(value) => value && setExpiration(value)}
            allowDeselect={false}
            readOnly={create.isPending}
            comboboxProps={{ withinPortal: true }}
          />
          {expiration === 'custom' && (
            <DatePickerInput
              label="Expiration date"
              placeholder="Pick a date"
              value={customDate}
              onChange={setCustomDate}
              minDate={today.add(1, 'day').format('YYYY-MM-DD')}
              maxDate={today
                .add(API_KEY_MAX_LIFETIME_DAYS - 1, 'day')
                .format('YYYY-MM-DD')}
              valueFormat={DATE_FORMAT}
              ariaLabels={CALENDAR_ARIA_LABELS}
              error={showErrors ? dateError : null}
              readOnly={create.isPending}
            />
          )}
          <ExpirationHint expiration={expiration} customDate={customDate} />
        </Stack>

        {create.isError && (
          <Alert
            color="red"
            icon={<IconAlertCircle size={18} />}
            title="Creation could not be confirmed"
          >
            <Stack gap="xs">
              <Text size="sm">{create.error.message}</Text>
              <Text size="sm">
                Close this dialog and check your key list before trying again.
                Revoke any key whose full value you did not receive.
              </Text>
            </Stack>
          </Alert>
        )}

        <Group justify="flex-end" gap="sm" className={classes.footer}>
          <Button
            type="button"
            variant="default"
            disabled={create.isPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create key
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function ExpirationHint({
  expiration,
  customDate,
}: {
  expiration: string;
  customDate: string | null;
}) {
  if (expiration === 'never') {
    return (
      <Text size="xs" c="amber.8" className={classes.hint}>
        <IconAlertTriangle size={14} stroke={1.8} aria-hidden />
        This key stays valid until you revoke it.
      </Text>
    );
  }
  if (expiration === 'custom') {
    if (!customDate) return null;
    return (
      <Text size="xs" c="dimmed">
        Expires at the end of {dayjs(customDate).format(DATE_FORMAT)}.
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      Expires on {dayjs().add(Number(expiration), 'day').format(DATE_FORMAT)}.
    </Text>
  );
}

function RevealedApiKey({
  created,
  onDone,
}: {
  created: CreatedApiKey;
  onDone: () => void;
}) {
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  // The submit button that had focus is gone; move focus to the next action.
  useEffect(() => copyButtonRef.current?.focus(), []);

  const copyKey = async () => {
    if (await copy(created.key).catch(() => false)) {
      setCopied(true);
      toast.success('API key copied');
    } else {
      toast.error('Could not copy the key. Select it and copy it manually.');
    }
  };

  return (
    <Stack gap="md">
      <Alert
        color="yellow"
        icon={<IconAlertTriangle size={18} />}
        title="This is the only time the key is shown"
      >
        Copy it somewhere safe now. After you close this dialog you won’t be
        able to view it again — revoke it and create a new one if it’s lost.
      </Alert>

      <Stack gap={6}>
        <Textarea
          label={`API key for ${created.apiKey.name}`}
          value={created.key}
          readOnly
          autosize
          minRows={2}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          classNames={{ input: classes.secretInput }}
        />
        <Text size="xs" c="dimmed">
          Send it in the <Code>x-api-key</Code> header.{' '}
          {created.apiKey.expiresAt
            ? `Expires ${dayjs(created.apiKey.expiresAt).format(DATE_FORMAT)}.`
            : 'Never expires.'}
        </Text>
      </Stack>

      <Group justify="flex-end" gap="sm" className={classes.footer}>
        <Button type="button" variant="default" onClick={onDone}>
          Done
        </Button>
        <Button
          type="button"
          ref={copyButtonRef}
          variant={copied ? 'light' : 'filled'}
          leftSection={
            copied ? (
              <IconCheck size={16} stroke={1.8} />
            ) : (
              <IconCopy size={16} stroke={1.8} />
            )
          }
          onClick={copyKey}
        >
          {copied ? 'Copied' : 'Copy key'}
        </Button>
      </Group>
    </Stack>
  );
}

function ApiKeysSkeleton() {
  return (
    <Stack gap="xs" aria-label="Loading API keys" aria-busy>
      {[0, 1].map((key) => (
        <Group key={key} gap="sm" wrap="nowrap" py="xs">
          <Skeleton height={34} width={34} radius="md" />
          <Stack gap={5} flex={1}>
            <Skeleton height={14} width="30%" radius="sm" />
            <Skeleton height={10} width="45%" radius="sm" />
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/** The stored leading characters only; the rest of the secret is unknown. */
function maskedIdentifier(key: ApiKeySummary): string {
  const start = key.start.startsWith(key.prefix)
    ? key.start
    : `${key.prefix}${key.start}`;
  return `${start}…`;
}

function expiryStatus(expiresAt: string | null): {
  label: string;
  badge: string | null;
  expired: boolean;
} {
  if (!expiresAt) {
    return { label: 'No expiration', badge: null, expired: false };
  }
  const at = dayjs(expiresAt);
  const now = dayjs();
  if (!at.isAfter(now)) {
    return {
      label: `Expired ${at.format(DATE_FORMAT)}`,
      badge: 'Expired',
      expired: true,
    };
  }
  return {
    label: `Expires ${at.format(DATE_FORMAT)}`,
    badge:
      at.diff(now, 'day', true) <= EXPIRING_SOON_DAYS ? 'Expires soon' : null,
    expired: false,
  };
}

function lifetimeSeconds(
  expiration: string,
  customDate: string | null,
): number | null {
  if (expiration === 'never') return null;
  if (expiration === 'custom' && customDate) {
    const seconds = dayjs(customDate).endOf('day').diff(dayjs(), 'second');
    return Math.min(
      Math.max(seconds, 1),
      API_KEY_MAX_LIFETIME_DAYS * DAY_SECONDS,
    );
  }
  return Number(expiration) * DAY_SECONDS;
}
