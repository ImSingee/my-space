import { createServerFn } from '@tanstack/react-start';
import { authMiddleware } from './auth';

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
    const { getAgentRunnerStatusSnapshot } =
      await import('./agent-runner/status');
    return getAgentRunnerStatusSnapshot();
  });
