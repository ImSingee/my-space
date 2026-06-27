import {
  Badge,
  Box,
  Button,
  Card,
  Center,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  IconChevronRight,
  IconHistory,
  IconRestore,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { toast } from 'sonner';
import { deploymentsQueryOptions } from '~queries/apps';
import type { DeploymentSummary } from '~server/apps/manage';
import { rollbackAppFn } from '~server/apps';

dayjs.extend(relativeTime);

const STATUS_COLOR: Record<DeploymentSummary['status'], string> = {
  building: 'ember',
  deployed: 'teal',
  failed: 'red',
};

function DeploymentRow({
  deployment,
  onRollback,
  rolling,
}: {
  deployment: DeploymentSummary;
  onRollback: (deploymentId: string) => void;
  rolling: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  const log = deployment.error || deployment.buildLog || '';

  return (
    <Card withBorder padding="sm" radius="md" key={deployment.id}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={600} size="sm">
            v{deployment.version}
          </Text>
          <Badge
            size="sm"
            variant="light"
            radius="sm"
            color={STATUS_COLOR[deployment.status]}
          >
            {deployment.status}
          </Badge>
          {deployment.isCurrent ? (
            <Badge size="sm" variant="outline" radius="sm" color="teal">
              Current
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed" truncate>
            {dayjs(deployment.createdAt).fromNow()}
          </Text>
        </Group>
        {deployment.canRollback ? (
          <Button
            size="compact-sm"
            variant="light"
            color="ember"
            leftSection={<IconRestore size={14} />}
            loading={rolling}
            onClick={() => onRollback(deployment.id)}
          >
            Restore
          </Button>
        ) : null}
      </Group>

      {deployment.message ? (
        <Text size="sm" mt={6} style={{ whiteSpace: 'pre-wrap' }}>
          {deployment.message}
        </Text>
      ) : null}

      {log ? (
        <Box mt={6}>
          <UnstyledButton
            onClick={handlers.toggle}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <IconChevronRight
              size={14}
              style={{
                transform: open ? 'rotate(90deg)' : undefined,
                transition: 'transform 150ms ease',
                color: 'var(--mantine-color-dimmed)',
              }}
            />
            <Text size="xs" c="dimmed" fw={500}>
              Build log
            </Text>
          </UnstyledButton>
          <Collapse expanded={open}>
            <Code
              block
              mt={6}
              style={{
                maxHeight: 260,
                overflow: 'auto',
                fontSize: 'var(--mantine-font-size-xs)',
                color: deployment.error
                  ? 'var(--mantine-color-red-6)'
                  : undefined,
              }}
            >
              {log}
            </Code>
          </Collapse>
        </Box>
      ) : null}
    </Card>
  );
}

export function DeploymentHistory({ appId }: { appId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const query = useQuery(deploymentsQueryOptions(appId));

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackAppFn({ data: { id: appId, deploymentId } }),
    onSuccess: (result) => {
      toast.success(`Restored v${result.version}`);
      void qc.invalidateQueries(deploymentsQueryOptions(appId));
      void router.invalidate();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const deployments = query.data ?? [];

  return (
    <Card withBorder padding="lg">
      <Group gap="xs" mb="sm">
        <IconHistory size={18} stroke={1.8} />
        <Text fw={600}>Deployment history</Text>
      </Group>

      {query.isLoading ? (
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      ) : deployments.length === 0 ? (
        <Text size="sm" c="dimmed">
          No deployments yet. Deploy this app to create the first version.
        </Text>
      ) : (
        <Stack gap="xs">
          {deployments.map((deployment) => (
            <DeploymentRow
              key={deployment.id}
              deployment={deployment}
              onRollback={(deploymentId) => rollback.mutate(deploymentId)}
              rolling={
                rollback.isPending && rollback.variables === deployment.id
              }
            />
          ))}
        </Stack>
      )}
    </Card>
  );
}
