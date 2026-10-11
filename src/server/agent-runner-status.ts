import { createServerFn } from '@tanstack/react-start';
import { authMiddleware } from './auth';
import { getAgentRunnerStatusSnapshot } from './agent-runner/status';

export type {
  ActiveAgentRunInfo,
  AgentRunLeaseState,
  AgentRunnerState,
  AgentRunnerStatusSnapshot,
} from './agent-runner/status';
export type { ConnectedRunnerInfo } from './agent-runner/hub';

export const getAgentRunnerStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    return getAgentRunnerStatusSnapshot();
  });
