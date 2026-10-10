import {
  Button,
  Checkbox,
  Collapse,
  DataList,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown } from '@tabler/icons-react';
import { useEffect, useId, useState } from 'react';
import type { ResourceRange } from '~auth/cli-policy';
import { appsQueryOptions } from '~queries/apps';
import { workflowsQueryOptions } from '~queries/workflows';
import type { DeviceDecision, DeviceRequest } from './device-api';
import { formatClockTime, formatCountdown, formatDuration } from './format';
import { DeviceCode, ViewHeader } from './layout';
import { permissionGroups, permissionSentence } from './permissions';
import classes from './device-approval.module.css';

type RequestReviewProps = {
  request: DeviceRequest;
  /** The decision currently in flight, if any. */
  pending: DeviceDecision | null;
  onDecide: (decision: DeviceDecision) => void;
  onExpire: () => void;
};

/**
 * The decision screen. Only what the decision needs is visible: who is
 * signing in where, the code to compare, and one sentence of access. Exact
 * scopes and resources stay one click away under "Details".
 */
export function RequestReview({
  request,
  pending,
  onDecide,
  onExpire,
}: RequestReviewProps) {
  const [confirmed, setConfirmed] = useState(false);
  const remaining = useRemaining(request.deadline);
  const expired = remaining <= 0;
  const busy = pending !== null;
  const access = permissionSentence(request.scopes, request.resources);

  // A decision already in flight gets the server's answer instead.
  useEffect(() => {
    if (expired && !busy) onExpire();
  }, [expired, busy, onExpire]);

  return (
    <>
      <ViewHeader title="Approve Hatch CLI?" focus>
        Signing in as{' '}
        <Text span inherit fw={500} c="var(--mantine-color-text)">
          {request.account}
        </Text>{' '}
        on {window.location.host}
      </ViewHeader>

      <section className={classes.sheet} aria-label="Device request">
        <div className={classes.codeBlock}>
          <DeviceCode code={request.userCode} />
          <Text size="sm" className={classes.codeCaption}>
            Check that it matches your device
            <br />
            <span
              className={classes.countdown}
              data-urgent={remaining < 60_000 || undefined}
            >
              Expires in {formatCountdown(remaining)}
            </span>
          </Text>
        </div>

        <div>
          <Text className={classes.access}>
            It will be able to <strong>{access.verb}</strong>{' '}
            <strong>{access.object}</strong>
            {access.future ? ', including ones you create later,' : ''} for{' '}
            {formatDuration(request.expiresIn)}.
          </Text>
          <Details request={request} />
        </div>

        <div className={classes.decision}>
          <Checkbox
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
            label="I started this, and the code matches my device"
            classNames={{ label: classes.confirmLabel }}
          />
          <div className={classes.actions}>
            <Button
              type="button"
              variant="default"
              size="md"
              loading={pending === 'deny'}
              disabled={busy && pending !== 'deny'}
              onClick={() => onDecide('deny')}
            >
              Deny
            </Button>
            <Button
              type="button"
              size="md"
              loading={pending === 'approve'}
              disabled={!confirmed || (busy && pending !== 'approve')}
              onClick={() => {
                if (confirmed) onDecide('approve');
              }}
            >
              Approve
            </Button>
          </div>
        </div>
      </section>

      <Text size="sm" c="dimmed" ta="center" className={classes.footnote}>
        Didn’t start this? Deny it. Approving would let someone else use your
        account.
      </Text>
    </>
  );
}

/** Milliseconds until `deadline`, refreshed every second. */
function useRemaining(deadline: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return deadline - now;
}

function Details({ request }: { request: DeviceRequest }) {
  const [opened, setOpened] = useState(false);
  const id = useId();
  return (
    <>
      <UnstyledButton
        className={classes.disclosure}
        aria-expanded={opened}
        aria-controls={id}
        onClick={() => setOpened((value) => !value)}
      >
        Details
        <IconChevronDown
          size={14}
          stroke={2}
          className={classes.disclosureIcon}
          data-opened={opened || undefined}
          aria-hidden
        />
      </UnstyledButton>
      <Collapse expanded={opened} id={id}>
        <DataList
          size="sm"
          gap="sm"
          labelWidth="7rem"
          className={classes.details}
        >
          {permissionGroups(request.scopes).map((group) => (
            <DataList.Item key={group.label}>
              <DataList.ItemLabel>{group.label}</DataList.ItemLabel>
              <DataList.ItemValue>{group.value.join(', ')}</DataList.ItemValue>
            </DataList.Item>
          ))}
          <DataList.Item>
            <DataList.ItemLabel>Applies to</DataList.ItemLabel>
            <DataList.ItemValue>
              <ResourceScope resources={request.resources} />
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Never includes</DataList.ItemLabel>
            <DataList.ItemValue>
              App data, secrets, AI providers, user management or Agent chats
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Request expires</DataList.ItemLabel>
            <DataList.ItemValue>
              {formatClockTime(new Date(request.grantExpiresAt))}
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Scopes</DataList.ItemLabel>
            <DataList.ItemValue className={classes.mono}>
              {request.scopes.join(' ')}
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Credential</DataList.ItemLabel>
            <DataList.ItemValue className={classes.mono}>
              {request.credentialType}, {request.expiresIn}s
            </DataList.ItemValue>
          </DataList.Item>
          <DataList.Item>
            <DataList.ItemLabel>Instance</DataList.ItemLabel>
            <DataList.ItemValue className={classes.mono}>
              {window.location.origin}
            </DataList.ItemValue>
          </DataList.Item>
        </DataList>
      </Collapse>
    </>
  );
}

function ResourceScope({ resources }: { resources: ResourceRange }) {
  if (resources.mode === 'all')
    return <>All apps and workflows, including future ones</>;
  if (!resources.apps.length && !resources.workflows.length)
    return <>No apps or workflows</>;
  return (
    <ul className={classes.resourceList}>
      <NamedResources kind="app" ids={resources.apps} />
      <NamedResources kind="workflow" ids={resources.workflows} />
    </ul>
  );
}

/**
 * Resolve granted IDs to names with the existing Cookie-authorized lists.
 * IDs stay visible, so a failed lookup still leaves exact information.
 */
function NamedResources({
  kind,
  ids,
}: {
  kind: 'app' | 'workflow';
  ids: string[];
}) {
  const apps = useQuery({
    ...appsQueryOptions,
    enabled: kind === 'app' && ids.length > 0,
  });
  const workflows = useQuery({
    ...workflowsQueryOptions,
    enabled: kind === 'workflow' && ids.length > 0,
  });
  const items = kind === 'app' ? apps.data : workflows.data;
  const names = new Map(items?.map((item) => [item.id, item.name]));
  return ids.map((id) => (
    <li key={id}>
      {names.get(id) ?? (kind === 'app' ? 'App' : 'Workflow')}{' '}
      <span className={classes.resourceId}>{id}</span>
    </li>
  ));
}
