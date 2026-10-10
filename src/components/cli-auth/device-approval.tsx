import { useMutation } from '@tanstack/react-query';
import { Fragment, useCallback, useRef, useState } from 'react';
import { CodeEntry } from './code-entry';
import {
  claimDeviceRequest,
  decideDeviceRequest,
  normalizeUserCode,
  type DeviceDecision,
  type DeviceOutcome,
  type DeviceRequest,
} from './device-api';
import { OutcomeView, ProblemView } from './device-status';
import { DeviceLayout } from './layout';
import {
  classifyClaimError,
  classifyDecisionError,
  type EntryProblem,
  type Problem,
} from './problems';
import { RequestReview } from './request-review';

type Stage =
  | { kind: 'entry'; problem: EntryProblem | null }
  | { kind: 'review'; request: DeviceRequest }
  | { kind: 'outcome'; outcome: DeviceOutcome; request: DeviceRequest }
  | {
      kind: 'problem';
      problem: Problem;
      userCode: string;
      request: DeviceRequest | null;
    };

export type DeviceApprovalProps = {
  /** Code from the verification link; it only prefills the form. */
  initialCode: string;
  /** Signed-in account shown before review, if already known. */
  account: string | null;
  /** Leave for the existing login page, returning to this code afterwards. */
  onSignIn: (userCode: string) => void;
  onSwitchAccount: (userCode: string) => void;
};

/**
 * Browser half of the device authorization grant.
 *
 * Opening the page never calls the server. "Review request" claims the
 * request for this Cookie session; Approve or Deny records one decision.
 * Each call is a single explicit action: it is never retried automatically,
 * a second action cannot start while one is in flight, and only an outcome
 * the server confirmed is ever shown as approved or denied.
 *
 * A different code in the URL starts a separate flow, so a review, its
 * confirmation and any late callbacks never carry over to another request.
 */
export function DeviceApproval(props: DeviceApprovalProps) {
  return (
    <DeviceApprovalFlow key={normalizeUserCode(props.initialCode)} {...props} />
  );
}

function DeviceApprovalFlow({
  initialCode,
  account,
  onSignIn,
  onSwitchAccount,
}: DeviceApprovalProps) {
  const [code, setCode] = useState(() => normalizeUserCode(initialCode));
  const [stage, setStage] = useState<Stage>({ kind: 'entry', problem: null });
  // Counts step changes. Each step remounts under a new key so its title (or
  // the code field) takes focus, even when one problem replaces another.
  const [transitions, setTransitions] = useState(0);
  // Synchronous guard: two clicks in one frame must not send two requests.
  const inFlight = useRef(false);

  // `networkMode: 'always'`: the default pauses a call made while offline and
  // sends it on reconnect, which would deliver a decision nobody re-confirmed.
  // Offline calls must fail now and go through the explicit recovery path.
  const claim = useMutation({
    mutationFn: claimDeviceRequest,
    retry: false,
    networkMode: 'always',
    meta: { errorToast: false },
  });
  const decide = useMutation({
    mutationFn: (input: { userCode: string; decision: DeviceDecision }) =>
      decideDeviceRequest(input.userCode, input.decision),
    retry: false,
    networkMode: 'always',
    meta: { errorToast: false },
  });

  const go = useCallback((next: Stage) => {
    setTransitions((count) => count + 1);
    setStage(next);
  }, []);

  const review = (userCode: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    claim.mutate(userCode, {
      onSuccess: (request) => go({ kind: 'review', request }),
      onError: (error) => {
        const result = classifyClaimError(error);
        if ('entry' in result) {
          setCode(userCode);
          go({ kind: 'entry', problem: result.entry });
        } else
          go({
            kind: 'problem',
            problem: result.problem,
            userCode,
            request: null,
          });
      },
      onSettled: () => {
        inFlight.current = false;
      },
    });
  };

  const submitDecision = (request: DeviceRequest, decision: DeviceDecision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    decide.mutate(
      { userCode: request.userCode, decision },
      {
        onSuccess: (outcome) => go({ kind: 'outcome', outcome, request }),
        onError: (error) =>
          go({
            kind: 'problem',
            problem: classifyDecisionError(error, decision),
            userCode: request.userCode,
            request,
          }),
        onSettled: () => {
          inFlight.current = false;
        },
      },
    );
  };

  const reviewedRequest = stage.kind === 'review' ? stage.request : null;
  const expire = useCallback(() => {
    if (!reviewedRequest) return;
    go({
      kind: 'problem',
      problem: 'expired',
      userCode: reviewedRequest.userCode,
      request: reviewedRequest,
    });
  }, [go, reviewedRequest]);

  const startOver = () => {
    claim.reset();
    decide.reset();
    setCode('');
    go({ kind: 'entry', problem: null });
  };

  return (
    <DeviceLayout>
      <Fragment key={transitions}>
        {stage.kind === 'entry' ? (
          <CodeEntry
            code={code}
            onCodeChange={(next) => {
              setCode(next);
              if (stage.problem) setStage({ kind: 'entry', problem: null });
            }}
            onSubmit={() => review(code)}
            pending={claim.isPending}
            problem={stage.problem}
            account={account}
            onSwitchAccount={() => onSwitchAccount(code)}
            focus={transitions > 0 || !code}
          />
        ) : stage.kind === 'review' ? (
          <RequestReview
            request={stage.request}
            pending={
              decide.isPending ? (decide.variables?.decision ?? null) : null
            }
            onDecide={(decision) => submitDecision(stage.request, decision)}
            onExpire={expire}
          />
        ) : stage.kind === 'outcome' ? (
          <OutcomeView
            outcome={stage.outcome}
            userCode={stage.request.userCode}
          />
        ) : (
          <ProblemView
            problem={stage.problem}
            userCode={stage.userCode}
            handlers={{
              onNewCode: startOver,
              onSignIn: () => onSignIn(stage.userCode),
              onRecheck: () => review(stage.userCode),
              onDeny: () => {
                if (stage.request) submitDecision(stage.request, 'deny');
              },
              pending: claim.isPending
                ? 'recheck'
                : decide.isPending
                  ? 'deny'
                  : null,
            }}
          />
        )}
      </Fragment>
    </DeviceLayout>
  );
}
