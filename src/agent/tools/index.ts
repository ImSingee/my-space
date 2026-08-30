/**
 * Agent tool definitions backed by the execution environment and the
 * platform's internal API (via the injected PlatformClient). Runs inside the
 * Agent Runner process — never import `~server/*` values here.
 */
import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';
import { createAttachmentTool } from './attachments';
import { createAskTool, type AskBridge } from './ask';
import { createCommandTool } from './command';
import { createFileTools } from './files';
import { createRequestEnvTool, type EnvBridge } from './request-env';
import type { AgentToolWithStreamDetails } from './shared';
import { createWebTools } from './web';
import { createWorkflowTools } from './workflows';

export type { AskBridge, EnvBridge };

export type CreateToolsOptions = {
  workflowBetaEnabled: boolean;
  platform: PlatformClient;
  ask?: AskBridge;
  requestEnv?: EnvBridge;
  readOnlyRoots?: string[];
  sessionId?: string;
  tavilyApiKey?: string | null;
};

export function createTools(
  env: ExecutionEnv,
  options: CreateToolsOptions,
): AgentToolWithStreamDetails[] {
  const shared = {
    platform: options.platform,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };
  const tools = [
    ...createFileTools(
      env,
      options.readOnlyRoots ? { readOnlyRoots: options.readOnlyRoots } : {},
    ),
    createCommandTool(env, options.sessionId),
    createAttachmentTool(shared),
    ...createAppTools(shared),
    ...(options.workflowBetaEnabled ? createWorkflowTools(shared) : []),
    ...createWebTools(
      options.tavilyApiKey ? { tavilyApiKey: options.tavilyApiKey } : {},
    ),
  ];
  if (options.ask) tools.push(createAskTool(options.ask));
  if (options.requestEnv) {
    tools.push(createRequestEnvTool(options.requestEnv));
  }
  return tools;
}
