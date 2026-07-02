import {
  ActionIcon,
  Badge,
  Button,
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
import { Claude, OpenAI } from '@lobehub/icons';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { useState } from 'react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconDotsVertical,
  IconPencil,
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
  updateModel,
  updateProvider,
  type ProviderModel,
  type ProviderWithModels,
} from '~server/providers';
import classes from './providers-panel.module.css';

const API_TYPE_OPTIONS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
];

const PROVIDER_AVATAR_SIZE = 40;

/** Official brand avatar chosen by API protocol: OpenAI for openai-*, Claude
 * for anthropic-messages, a neutral fallback otherwise. */
function ProviderAvatar({ apiType }: { apiType: string }) {
  if (apiType === 'anthropic-messages') {
    return <Claude.Avatar size={PROVIDER_AVATAR_SIZE} />;
  }
  if (apiType.startsWith('openai')) {
    return <OpenAI.Avatar size={PROVIDER_AVATAR_SIZE} type="gpt5" />;
  }
  return (
    <ThemeIcon
      size={PROVIDER_AVATAR_SIZE}
      radius="xl"
      variant="light"
      color="ember"
    >
      <IconRobot size={22} stroke={1.5} />
    </ThemeIcon>
  );
}

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
  model,
}: {
  opened: boolean;
  onClose: () => void;
  providerId: string;
  model?: ProviderModel;
}) {
  const qc = useQueryClient();
  const editing = Boolean(model);
  const form = useForm<ModelFormValues>({
    initialValues: {
      modelId: model?.modelId ?? '',
      name: model?.name ?? '',
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow ?? 128000,
      maxTokens: model?.maxTokens ?? 8192,
    },
    validate: {
      modelId: (v) => (v.trim() ? null : 'Required'),
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: ModelFormValues) => {
      // Display name is optional: fall back to the model ID when left blank.
      const name = values.name.trim() || values.modelId.trim();
      if (model) {
        await updateModel({ data: { id: model.id, ...values, name } });
        return;
      }
      await createModel({
        data: { providerId, ...values, name, input: ['text'] },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });
      toast.success(editing ? 'Model updated' : 'Model added');
      form.reset();
      onClose();
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editing ? 'Edit model' : 'Add model'}
      centered
    >
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
            description="Optional — defaults to the model ID"
            placeholder={form.values.modelId.trim() || 'GPT-5.5'}
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
              {editing ? 'Save' : 'Add model'}
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
  // null = closed, 'new' = add model, ProviderModel = edit that model.
  const [modelTarget, setModelTarget] = useState<ProviderModel | 'new' | null>(
    null,
  );

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });

  const toggleEnabled = useMutation({
    mutationKey: ['provider-enabled', provider.id],
    mutationFn: (enabled: boolean) =>
      updateProvider({ data: { id: provider.id, enabled } }),
    // Flip the switch immediately; roll back if the server rejects it (the
    // global mutation error toast reports the failure).
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: providersQueryOptions.queryKey });
      const previous = qc.getQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
      );
      qc.setQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
        (old) =>
          old?.map((p) => (p.id === provider.id ? { ...p, enabled } : p)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        qc.setQueryData(providersQueryOptions.queryKey, context.previous);
      }
    },
    // Only refetch once the LAST in-flight toggle settles: an earlier
    // toggle's refetch would otherwise overwrite a newer optimistic flip.
    onSettled: () => {
      if (
        qc.isMutating({ mutationKey: ['provider-enabled', provider.id] }) === 1
      ) {
        void invalidate();
      }
    },
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
    <div className={classes.provider}>
      <div className={classes.providerHead}>
        <Group className={classes.providerInfo} wrap="nowrap" gap="sm">
          <ProviderAvatar apiType={provider.apiType} />
          <Stack gap={3} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600} truncate>
                {provider.name}
              </Text>
              {provider.enabled ? null : (
                <Badge variant="default" size="sm">
                  Off
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {provider.baseUrl}
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
                <Group gap="sm" wrap="nowrap" className={classes.modelMain}>
                  <Text size="sm" fw={500} className={classes.modelName}>
                    {m.name}
                  </Text>
                  <Text
                    size="xs"
                    c="dimmed"
                    ff="monospace"
                    truncate
                    visibleFrom="xs"
                    className={classes.modelId}
                  >
                    {m.modelId}
                  </Text>
                </Group>
                <Group gap={2} wrap="nowrap" className={classes.modelActions}>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label="Edit model"
                    onClick={() => setModelTarget(m)}
                  >
                    <IconPencil size={15} stroke={1.6} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label="Remove model"
                    onClick={() =>
                      modals.openConfirmModal({
                        title: 'Remove model',
                        centered: true,
                        children: (
                          <Text size="sm">
                            Remove <b>{m.name}</b>? Sessions using it will fall
                            back to another model.
                          </Text>
                        ),
                        labels: { confirm: 'Remove', cancel: 'Cancel' },
                        confirmProps: { color: 'red' },
                        onConfirm: () => removeModel.mutate(m.id),
                      })
                    }
                  >
                    <IconTrash size={15} stroke={1.6} />
                  </ActionIcon>
                </Group>
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
            onClick={() => setModelTarget('new')}
          >
            Add model
          </Button>
        </Group>
      </div>

      {editOpen && (
        <ProviderFormModal
          opened
          onClose={editHandlers.close}
          provider={provider}
        />
      )}
      <ModelFormModal
        key={modelTarget && modelTarget !== 'new' ? modelTarget.id : 'new'}
        opened={modelTarget !== null}
        onClose={() => setModelTarget(null)}
        providerId={provider.id}
        model={modelTarget && modelTarget !== 'new' ? modelTarget : undefined}
      />
    </div>
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
      <Stack align="center" gap="xs" py={64} px="md">
        <ThemeIcon size={52} radius="xl" variant="light" color="ember">
          <IconRobot size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={600} mt="xs">
          No providers yet
        </Text>
        <Text size="sm" c="dimmed" ta="center" maw={420}>
          Add an LLM provider — Anthropic, OpenAI, or any compatible endpoint —
          and its models so the Agent can start building apps.
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
    );
  }

  return (
    <div className={classes.providerList}>
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </div>
  );
}
