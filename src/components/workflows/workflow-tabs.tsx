import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconPlayerPlay,
  IconSettings,
  IconTimeline,
} from '@tabler/icons-react';

type Tab = 'run' | 'executions' | 'manage';

/**
 * Segmented Run / Runs / Manage navigation shared by a workflow's three
 * surfaces, mirroring how an app splits its "view" and "manage" pages.
 */
export function WorkflowTabs({ id, active }: { id: string; active: Tab }) {
  return (
    <Button.Group>
      <Button
        renderRoot={(props) => (
          <Link
            to="/workflows/$workflowId"
            params={{ workflowId: id }}
            {...props}
          />
        )}
        variant={active === 'run' ? 'light' : 'default'}
        color={active === 'run' ? 'ember' : 'gray'}
        leftSection={<IconPlayerPlay size={16} stroke={1.8} />}
      >
        Run
      </Button>
      <Button
        renderRoot={(props) => (
          <Link
            to="/workflows/$workflowId/executions"
            params={{ workflowId: id }}
            {...props}
          />
        )}
        variant={active === 'executions' ? 'light' : 'default'}
        color={active === 'executions' ? 'ember' : 'gray'}
        leftSection={<IconTimeline size={16} stroke={1.8} />}
      >
        Executions
      </Button>
      <Button
        renderRoot={(props) => (
          <Link
            to="/workflows/$workflowId/manage"
            params={{ workflowId: id }}
            {...props}
          />
        )}
        variant={active === 'manage' ? 'light' : 'default'}
        color={active === 'manage' ? 'ember' : 'gray'}
        leftSection={<IconSettings size={16} stroke={1.8} />}
      >
        Manage
      </Button>
    </Button.Group>
  );
}
