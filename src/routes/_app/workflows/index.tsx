import {
  Button,
  Card,
  Group,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  IconPlus,
  IconRepeat,
  IconSettings,
  IconTimeline,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Page } from '~components/app-shell/page';
import { AppGlyph } from '~components/apps/app-glyph';
import { WorkflowStatusBadge } from '~components/workflows/status-badge';
import { listWorkflows } from '~server/workflows';
import classes from '../apps/apps.module.css';

dayjs.extend(relativeTime);

export const Route = createFileRoute('/_app/workflows/')({
  loader: () => listWorkflows(),
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const workflows = Route.useLoaderData();

  return (
    <Page
      title="Workflows"
      description="Headless, code-based jobs the Agent builds — run them manually, on a schedule, or via webhook."
      actions={
        <Group gap="xs">
          <Button
            component={Link}
            to="/executions"
            variant="default"
            leftSection={<IconTimeline size={16} stroke={1.8} />}
          >
            Executions
          </Button>
          <Button
            component={Link}
            to="/agent"
            leftSection={<IconPlus size={16} stroke={1.8} />}
          >
            New workflow
          </Button>
        </Group>
      }
    >
      {workflows.length === 0 ? (
        <Stack align="center" gap="xs" py={80} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="ember">
            <IconRepeat size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={600} mt="xs">
            No workflows yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            Ask the Agent for a periodic or repetitive task — a daily digest, a
            sync job, an inbound-webhook automation — and it will write, bundle,
            and deploy it here.
          </Text>
          <Button
            component={Link}
            to="/agent"
            mt="md"
            leftSection={<IconPlus size={16} stroke={1.8} />}
          >
            Build your first workflow
          </Button>
        </Stack>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {workflows.map((workflow) => (
            <Card
              key={workflow.id}
              padding="lg"
              radius="lg"
              className={classes.card}
            >
              <Group
                justify="space-between"
                wrap="nowrap"
                align="flex-start"
                gap="sm"
              >
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <AppGlyph name={workflow.name} seed={workflow.id} />
                  <Text
                    fw={600}
                    truncate
                    renderRoot={(props) => (
                      <Link
                        to="/workflows/$workflowId"
                        params={{ workflowId: workflow.id }}
                        {...props}
                        className={[props.className, classes.primaryLink]
                          .filter(Boolean)
                          .join(' ')}
                      />
                    )}
                  >
                    {workflow.name}
                  </Text>
                </Group>
                <WorkflowStatusBadge status={workflow.status} />
              </Group>
              <Text size="sm" c="dimmed" mt="sm" lineClamp={2}>
                {workflow.description || 'No description yet.'}
              </Text>
              <Group justify="space-between" align="center" mt="auto" pt="md">
                <Text size="xs" c="dimmed">
                  Updated {dayjs(workflow.updatedAt).fromNow()}
                </Text>
                <Tooltip label="Manage workflow" position="top" withArrow>
                  <Button
                    renderRoot={(props) => (
                      <Link
                        to="/workflows/$workflowId/manage"
                        params={{ workflowId: workflow.id }}
                        {...props}
                      />
                    )}
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    className={classes.cardAction}
                    leftSection={<IconSettings size={15} stroke={1.7} />}
                  >
                    Manage
                  </Button>
                </Tooltip>
              </Group>
            </Card>
          ))}
        </SimpleGrid>
      )}
    </Page>
  );
}
