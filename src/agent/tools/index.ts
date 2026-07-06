/**
 * Agent tool definitions backed by the execution environment and the
 * platform's internal API (via the injected PlatformClient). Runs inside the
 * Agent Runner process — never import `~server/*` values here.
 */
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { PlatformClient } from '../platform-client';
import { createAppTools } from './apps';
import { createAskTool, type AskBridge } from './ask';
import { createCommandTool } from './command';
import { createFileTools } from './files';
import { createWorkflowTools } from './workflows';

export type { AskBridge };

export type CreateToolsOptions = {
  platform: PlatformClient;
  ask?: AskBridge;
  sessionId?: string;
};

export function createTools(
  env: ExecutionEnv,
  options: CreateToolsOptions,
): AgentTool[] {
  const shared = {
    platform: options.platform,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };
  const tools = [
    ...createFileTools(env),
    createCommandTool(env),
    ...createAppTools(shared),
    ...createWorkflowTools(shared),
  ];
  if (options.ask) tools.push(createAskTool(options.ask));
  return tools;
}
