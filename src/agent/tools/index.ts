/** Server-only: Agent tool definitions backed by the execution environment. */
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { createAppTools } from './apps';
import { createAskTool, type AskBridge } from './ask';
import { createCommandTool } from './command';
import { createFileTools } from './files';
import { createWorkflowTools } from './workflows';

export type { AskBridge };

export type CreateToolsOptions = {
  ask?: AskBridge;
  sessionId?: string;
};

export function createTools(
  env: ExecutionEnv,
  options: CreateToolsOptions = {},
): AgentTool[] {
  const tools = [
    ...createFileTools(env),
    createCommandTool(env),
    ...createAppTools(options),
    ...createWorkflowTools(options),
  ];
  if (options.ask) tools.push(createAskTool(options.ask));
  return tools;
}
