import {
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Stack,
  Text,
  Timeline,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconArrowLeft, IconPlayerStop } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Page } from '~components/app-shell/page';
import {
  RunStatusBadge,
  RunStatusBullet,
} from '~components/workflows/run-status';
import { formatDuration, formatExact } from '~lib/format';
import {
  workflowRunQueryOptions,
  workflowRunsQueryOptions,
} from '~queries/workflows';
import { cancelWorkflowRunFn, getWorkflowRun } from '~server/workflows';
import type { WorkflowRunStepView } from '~server/workflows/manage';

export const Route = createFileRoute(
  '/_app/workflows/$workflowId/executions/$runId',
)({
  loader: async ({ params }) => {
    const run = await getWorkflowRun({ data: params.runId });
    // Scope the run to its workflow so a deep link like
    // /workflows/<A>/executions/<run-of-B> can't render or cancel B under A.
    if (!run || run.workflowId !== params.workflowId) throw notFound();
    return run;
  },
  component: WorkflowExecutionPage,
});

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StepItem({ step }: { step: WorkflowRunStepView }) {
  return (
    <Timeline.Item
      lineVariant={step.status === 'failed' ? 'dashed' : 'solid'}
      bullet={<RunStatusBullet status={step.status} filled />}
    >
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fw={600} size="sm">
          {step.name}
        </Text>
        {step.attempt > 1 ? (
          <Badge size="xs" variant="light" color="gray" radius="sm">
            attempt {step.attempt}
          </Badge>
        ) : null}
        <Text size="xs" c="dimmed">
          {formatDuration(step.durationMs)}
        </Text>
      </Group>
      {step.error ? (
        <Code
          block
          mt={6}
          style={{
            fontSize: 'var(--mantine-font-size-xs)',
            color: 'var(--mantine-color-red-7)',
          }}
        >
          {step.error}
        </Code>
      ) : null}
      {step.output != null && step.output !== '' ? (
        <Code block mt={6} style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
          {pretty(step.output)}
        </Code>
      ) : null}
    </Timeline.Item>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        {title}
      </Text>
      {children}
    </Box>
  );
}

function WorkflowExecutionPage() {
  const initial = Route.useLoaderData();
  const { runId, workflowId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...workflowRunQueryOptions(runId),
    initialData: initial,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === 'queued' || status === 'running' ? 1200 : false;
    },
  });
  const run = data ?? initial;
  const active = run.status === 'queued' || run.status === 'running';

  const cancel = useMutation({
    mutationFn: () => cancelWorkflowRunFn({ data: runId }),
    onSuccess: () => {
      toast.success('Execution canceled');
      void queryClient.invalidateQueries(workflowRunQueryOptions(runId));
      void queryClient.invalidateQueries(workflowRunsQueryOptions(workflowId));
    },
  });

  return (
    <Page
      size={920}
      title={
        <Group gap="sm" align="center" wrap="nowrap">
          Execution
          <RunStatusBadge status={run.status} />
        </Group>
      }
      description={
        <>
          {run.trigger} trigger
          {run.version != null ? ` · v${run.version}` : ''} ·{' '}
          {formatExact(run.startedAt ?? run.createdAt)} ·{' '}
          {formatDuration(run.durationMs)}
        </>
      }
      actions={
        <>
          <Button
            renderRoot={(props) => (
              <Link
                to="/workflows/$workflowId/executions"
                params={{ workflowId }}
                {...props}
              />
            )}
            variant="default"
            leftSection={<IconArrowLeft size={16} stroke={1.8} />}
          >
            Back
          </Button>
          {active ? (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size={16} stroke={1.8} />}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          ) : null}
        </>
      }
    >
      <Stack gap="xl">
        <Section title="Steps">
          {run.steps.length === 0 ? (
            <Text size="sm" c="dimmed">
              {active
                ? 'Waiting for the first step…'
                : 'This execution recorded no steps.'}
            </Text>
          ) : (
            <Timeline
              bulletSize={20}
              lineWidth={2}
              active={-1}
              color="gray"
              styles={{
                itemBody: { paddingBottom: 'var(--mantine-spacing-md)' },
              }}
            >
              {run.steps.map((step) => (
                <StepItem key={`${step.seq}-${step.attempt}`} step={step} />
              ))}
            </Timeline>
          )}
        </Section>

        {run.error ? (
          <>
            <Divider />
            <Section title="Error">
              <Code block style={{ color: 'var(--mantine-color-red-7)' }}>
                {run.error}
              </Code>
            </Section>
          </>
        ) : null}

        <Divider />
        <Section title="Input">
          <Code block>{pretty(run.input ?? {})}</Code>
        </Section>

        {run.output != null ? (
          <>
            <Divider />
            <Section title="Output">
              <Code block>{pretty(run.output)}</Code>
            </Section>
          </>
        ) : null}

        {run.log ? (
          <>
            <Divider />
            <Section title="Log">
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {run.log}
              </Code>
            </Section>
          </>
        ) : null}
      </Stack>
    </Page>
  );
}
