import {
  ActionIcon,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Menu,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconDotsVertical,
  IconPlus,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { providersQueryOptions } from '~queries/agent';
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  updateProvider,
  type ProviderWithModels,
} from '~server/providers';
import classes from './providers-panel.module.css';

const API_TYPE_OPTIONS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
];

const API_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  API_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

function baseUrlHint(apiType: string): string {
  switch (apiType) {
    case 'anthropic-messages':
      return 'e.g. https://api.anthropic.com — the SDK appends /v1/messages';
    case 'openai-responses':
      return 'e.g. https://api.openai.com/v1 — the SDK appends /responses';
    case 'openai-completions':
      return 'e.g. https://api.openai.com/v1 — the SDK appends /chat/completions';
    default:
      return '';
  }
}

type ProviderFormValues = {
  name: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
};

export function ProviderFormModal({
  opened,
  onClose,
  provider,
}: {
  opened: boolean;
  onClose: () => void;
  provider?: ProviderWithModels;
}) {
  const qc = useQueryClient();
  const editing = Boolean(provider);
  const form = useForm<ProviderFormValues>({
    initialValues: {
      name: provider?.name ?? '',
      apiType: provider?.apiType ?? 'anthropic-messages',
      baseUrl: provider?.baseUrl ?? '',
      apiKey: '',
    },
    validate: {
      name: (v) => (v.trim() ? null : 'Required'),
      baseUrl: (v) => (v.trim() ? null : 'Required'),
      apiKey: (v) => (editing || v.trim() ? null : 'Required'),
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      if (provider) {
        await updateProvider({
          data: {
            id: provider.id,
            name: values.name,
            apiType: values.apiType as ProviderWithModels['apiType'],
            baseUrl: values.baseUrl,
            apiKey: values.apiKey || undefined,
          },
        });
      } else {
        await createProvider({
          data: {
            name: values.name,
            apiType: values.apiType as ProviderWithModels['apiType'],
            baseUrl: values.baseUrl,
            apiKey: values.apiKey,
          },
        });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });
      toast.success(editing ? 'Provider updated' : 'Provider added');
      form.reset();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editing ? 'Edit provider' : 'Add provider'}
      centered
    >
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <TextInput
            label="Name"
            placeholder="My provider"
            {...form.getInputProps('name')}
          />
          <Select
            label="API type"
            data={API_TYPE_OPTIONS}
            allowDeselect={false}
            {...form.getInputProps('apiType')}
          />
          <TextInput
            label="Base URL"
            placeholder="https://api.example.com"
            description={baseUrlHint(form.values.apiType)}
            {...form.getInputProps('baseUrl')}
          />
          <TextInput
            label="API key"
            type="password"
            placeholder={editing ? 'Leave blank to keep current key' : 'sk-...'}
            {...form.getInputProps('apiKey')}
          />
          <Group justify="flex-end" mt="xs">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {editing ? 'Save' : 'Add provider'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

type ModelFormValues = {
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
};

function ModelFormModal({
  opened,
  onClose,
  providerId,
}: {
  opened: boolean;
  onClose: () => void;
  providerId: string;
}) {
  const qc = useQueryClient();
  const form = useForm<ModelFormValues>({
    initialValues: {
      modelId: '',
      name: '',
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
    },
    validate: {
      modelId: (v) => (v.trim() ? null : 'Required'),
      name: (v) => (v.trim() ? null : 'Required'),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: ModelFormValues) =>
      createModel({ data: { providerId, ...values, input: ['text'] } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });
      toast.success('Model added');
      form.reset();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Add model" centered>
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <TextInput
            label="Model ID"
            placeholder="gpt-5.5"
            description="The identifier sent to the provider"
            {...form.getInputProps('modelId')}
          />
          <TextInput
            label="Display name"
            placeholder="GPT-5.5"
            {...form.getInputProps('name')}
          />
          <Group grow>
            <NumberInput
              label="Context window"
              min={1000}
              step={1000}
              thousandSeparator=","
              {...form.getInputProps('contextWindow')}
            />
            <NumberInput
              label="Max output tokens"
              min={256}
              step={256}
              thousandSeparator=","
              {...form.getInputProps('maxTokens')}
            />
          </Group>
          <Switch
            label="Reasoning model"
            description="Enable extended thinking when supported"
            {...form.getInputProps('reasoning', { type: 'checkbox' })}
          />
          <Group justify="flex-end" mt="xs">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Add model
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function ProviderCard({ provider }: { provider: ProviderWithModels }) {
  const qc = useQueryClient();
  const [editOpen, editHandlers] = useDisclosure(false);
  const [modelOpen, modelHandlers] = useDisclosure(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      updateProvider({ data: { id: provider.id, enabled } }),
    onSuccess: invalidate,
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider({ data: { id: provider.id } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Provider removed');
    },
  });

  const removeModel = useMutation({
    mutationFn: (id: string) => deleteModel({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toast.success('Model removed');
    },
  });

  return (
    <Card radius="md">
      <div className={classes.providerHead}>
        <Group className={classes.providerInfo} wrap="nowrap" gap="sm">
          <Avatar variant="light" color="ember" size={42} radius="md">
            {provider.name.slice(0, 1).toUpperCase()}
          </Avatar>
          <Stack gap={3} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600} truncate>
                {provider.name}
              </Text>
              <Badge variant="light" size="sm" color="gray">
                {API_TYPE_LABEL[provider.apiType] ?? provider.apiType}
              </Badge>
              {provider.enabled ? null : (
                <Badge variant="default" size="sm">
                  Off
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {provider.baseUrl} · key {provider.apiKeyPreview}
            </Text>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Tooltip
            label={provider.enabled ? 'Enabled' : 'Disabled'}
            withArrow
            position="left"
          >
            <Switch
              checked={provider.enabled}
              onChange={(e) => toggleEnabled.mutate(e.currentTarget.checked)}
              size="sm"
            />
          </Tooltip>
          <Menu position="bottom-end" withArrow shadow="md">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Provider menu"
              >
                <IconDotsVertical size={18} stroke={1.6} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={editHandlers.open}>Edit provider</Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={15} stroke={1.6} />}
                onClick={() =>
                  modals.openConfirmModal({
                    title: 'Remove provider',
                    centered: true,
                    children: (
                      <Text size="sm">
                        Remove <b>{provider.name}</b> and its models? Sessions
                        using it will fall back to another model.
                      </Text>
                    ),
                    labels: { confirm: 'Remove', cancel: 'Cancel' },
                    confirmProps: { color: 'red' },
                    onConfirm: () => removeProvider.mutate(),
                  })
                }
              >
                Remove provider
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </div>

      <div className={classes.models}>
        {provider.models.length > 0 ? (
          <Stack gap={2}>
            {provider.models.map((m) => (
              <div key={m.id} className={classes.modelRow}>
                <Group className={classes.modelName} gap="xs" wrap="nowrap">
                  <Text size="sm" fw={500} truncate>
                    {m.name}
                  </Text>
                  {m.reasoning ? (
                    <Badge size="xs" variant="light" color="ember">
                      reasoning
                    </Badge>
                  ) : null}
                </Group>
                <Code visibleFrom="xs">{m.modelId}</Code>
                <Text size="xs" c="dimmed" visibleFrom="sm">
                  {m.contextWindow.toLocaleString()} ctx
                </Text>
                <ActionIcon
                  className={classes.modelRemove}
                  variant="subtle"
                  color="red"
                  size="sm"
                  aria-label="Remove model"
                  onClick={() => removeModel.mutate(m.id)}
                >
                  <IconTrash size={15} stroke={1.6} />
                </ActionIcon>
              </div>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" className={classes.emptyModels}>
            No models yet — add one to enable this provider.
          </Text>
        )}
        <Group mt="xs">
          <Button
            type="button"
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPlus size={14} stroke={2} />}
            onClick={modelHandlers.open}
          >
            Add model
          </Button>
        </Group>
      </div>

      <ProviderFormModal
        opened={editOpen}
        onClose={editHandlers.close}
        provider={provider}
      />
      <ModelFormModal
        opened={modelOpen}
        onClose={modelHandlers.close}
        providerId={provider.id}
      />
    </Card>
  );
}

export function ProvidersPanel({
  onAddProvider,
}: {
  onAddProvider: () => void;
}) {
  const { data: providers } = useSuspenseQuery(providersQueryOptions);

  if (providers.length === 0) {
    return (
      <Card withBorder padding={0} radius="md">
        <Stack align="center" gap="xs" py={64} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="ember">
            <IconRobot size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={600} mt="xs">
            No providers yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            Add an LLM provider — Anthropic, OpenAI, or any compatible endpoint
            — and its models so the Agent can start building apps.
          </Text>
          <Button
            type="button"
            mt="md"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={onAddProvider}
          >
            Add provider
          </Button>
        </Stack>
      </Card>
    );
  }

  return (
    <Stack gap="md">
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </Stack>
  );
}
