import { Button, Checkbox, Text } from '@mantine/core';
import { useState } from 'react';
import type { DeviceDecision, DeviceRequest } from './device-api';
import { DeviceCode, ViewHeader } from './layout';
import classes from './device-approval.module.css';

type RequestReviewProps = {
  request: DeviceRequest;
  /** The signed-in account the device will act as. */
  account: string | null;
  /** The decision currently in flight, if any. */
  pending: DeviceDecision | null;
  onDecide: (decision: DeviceDecision) => void;
};

/**
 * The decision screen: who is signing in where, the code to compare, and what
 * approving grants. Approve needs an explicit confirmation; Deny does not.
 */
export function RequestReview({
  request,
  account,
  pending,
  onDecide,
}: RequestReviewProps) {
  const [confirmed, setConfirmed] = useState(false);
  const busy = pending !== null;

  return (
    <>
      <ViewHeader title="Approve Hatch CLI?" focus>
        Signing in as{' '}
        <Text span inherit fw={500} c="var(--mantine-color-text)">
          {account ?? 'your account'}
        </Text>{' '}
        on {window.location.host}
      </ViewHeader>

      <section className={classes.sheet} aria-label="Device request">
        <div className={classes.codeBlock}>
          <DeviceCode code={request.userCode} />
          <Text size="sm" className={classes.codeCaption}>
            Check that it matches your device
          </Text>
        </div>

        <Text className={classes.access}>
          It will get <strong>full access to your Hatch account</strong>, the
          same as signing in here, until it signs out.
        </Text>

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
