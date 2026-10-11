import {
  Alert,
  Anchor,
  Box,
  Button,
  Code,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { appTailscaleConfigSchema } from '~/app-tailscale';
import {
  appTailscaleQueryOptions,
  appTailscaleStatusesQueryOptions,
} from '~queries/app-tailscale';
import { tailscaleQueryOptions } from '~queries/tailscale';
import { configureAppTailscale } from '~server/app-tailscale';
import { AppTailscaleBadge } from '~components/apps/app-tailscale-status';

export function AppTailscaleServicePanel({
  appId,
  slug,
}: {
  appId: string;
  slug: string;
}) {
  const queryClient = useQueryClient();
  const query = useQuery(appTailscaleQueryOptions(appId));
  const global = useQuery(tailscaleQueryOptions);
  const [editedName, setEditedName] = useState<string | null>(null);
  const name =
    editedName ??
    query.data?.config?.serviceName ??
    slug.slice(0, 63).replace(/-$/, '');
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      configureAppTailscale({
        data: appTailscaleConfigSchema.parse({
          appId,
          serviceName: enabled
            ? name
            : (query.data?.config?.serviceName ?? name),
          enabled,
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(appTailscaleQueryOptions(appId).queryKey, data);
      void queryClient.invalidateQueries(appTailscaleStatusesQueryOptions);
      setEditedName(null);
      toast.success(
        data.config?.enabled ? 'Service settings saved' : 'Service stopped',
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Unable to update this Service',
      ),
  });
  if (query.isPending) return <Skeleton height={180} />;
  if (query.isError || !query.data)
    return (
      <Alert color="red">
        Unable to load the App access address.{' '}
        <Button
          type="button"
          variant="subtle"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </Alert>
    );
  const status = query.data;
  const preview = status.suffix ? `https://${name}.${status.suffix}/` : null;
  const policy = JSON.stringify(
    {
      autoApprovers: {
        services: {
          [`svc:${name}`]: global.data?.tags?.length
            ? global.data.tags
            : ['tag:hatch'],
        },
      },
      grants: [
        { src: ['autogroup:member'], dst: [`svc:${name}`], ip: ['443'] },
      ],
    },
    null,
    2,
  );
  return (
    <Box component="section">
      <Stack gap="md">
        <Group justify="space-between">
          <Text fw={600} fz="lg">
            Access address
          </Text>
          <AppTailscaleBadge state={status.state} />
        </Group>
        <Text size="sm" c="dimmed">
          Give this App its own private HTTPS address. Tailscale controls who
          can reach it; Hatch sign-in is still required.
        </Text>
        <TextInput
          label="Tailscale service name"
          description="Use a dedicated Service name for this App across your tailnet."
          value={name}
          onChange={(event) => setEditedName(event.currentTarget.value)}
          disabled={mutation.isPending}
        />
        {preview && <Code>{preview}</Code>}
        <Group>
          <Button
            type="button"
            loading={mutation.isPending}
            onClick={() => mutation.mutate(true)}
          >
            {status.config?.enabled ? 'Save and advertise' : 'Enable address'}
          </Button>
          {status.config?.enabled && (
            <Button
              type="button"
              variant="default"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(false)}
            >
              Stop advertising
            </Button>
          )}
          {status.state === 'ready' && status.origin && (
            <>
              <Button
                type="button"
                component="a"
                href={status.origin + '/'}
                target="_blank"
                rel="noreferrer"
              >
                Open App
              </Button>
              <Button
                type="button"
                variant="default"
                onClick={() => {
                  copy(status.origin + '/');
                  toast.success('Address copied');
                }}
              >
                Copy address
              </Button>
            </>
          )}
        </Group>
        {status.message && (
          <Alert color={status.state === 'error' ? 'red' : 'blue'}>
            {status.message}
          </Alert>
        )}
        {status.config?.enabled && status.state !== 'ready' && (
          <Alert title="Finish configuration in Tailscale" color="blue">
            <Stack gap="xs">
              <Text size="sm">
                Add a tag to the Hatch node. Define{' '}
                <Code>svc:{status.config.serviceName}</Code> with endpoint{' '}
                <Code>tcp:443</Code>, then approve this host or configure
                automatic approval. Access grants are a separate setting.
              </Text>
              <Anchor
                href="https://console.tailscale.com/admin/services"
                target="_blank"
                rel="noreferrer"
              >
                Open Tailscale Services
              </Anchor>
              <Button
                type="button"
                variant="light"
                size="xs"
                onClick={() => {
                  copy(`svc:${status.config?.serviceName}\ntcp:443`);
                  toast.success('Service details copied');
                }}
              >
                Copy Service details
              </Button>
            </Stack>
          </Alert>
        )}
        <details>
          <summary>Example Tailscale policy</summary>
          <Stack gap="xs" mt="sm">
            <Text size="sm">
              Merge these rules into your existing policy and use a tag assigned
              to the Hatch node. The example allows tailnet members; adjust it
              to your intended audience. It does not create the Service
              definition.
            </Text>
            <Code block>{policy}</Code>
            <Button
              type="button"
              variant="default"
              onClick={() => {
                copy(policy);
                toast.success('Policy copied');
              }}
            >
              Copy policy example
            </Button>
          </Stack>
        </details>
        {status.state === 'ready' && (
          <Text size="sm" c="dimmed">
            HTTPS is ready. Client access still depends on your Tailscale
            policy.
          </Text>
        )}
      </Stack>
    </Box>
  );
}
