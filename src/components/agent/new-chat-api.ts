import { createSession } from '~server/agent-sessions';

export async function createEmptyAgentSession(): Promise<{ id: string }> {
  return createSession({ data: {} });
}
