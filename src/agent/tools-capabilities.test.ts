import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { describe, expect, it } from 'vitest';
import type { PlatformClient } from './platform-client';
import { createTools } from './tools';

const WORKFLOW_TOOL_NAMES = [
  'list_workflows',
  'get_workflow',
  'checkout_workflow',
  'create_workflow',
  'deploy_workflow',
  'rollback_workflow',
];

describe('Agent capability registration', () => {
  it('keeps App tools while Workflow tools are temporarily disabled', () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const tools = createTools(env, {
      workflowBetaEnabled: false,
      platform: {} as PlatformClient,
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['list_apps', 'get_app']));
    expect(names).not.toEqual(expect.arrayContaining(WORKFLOW_TOOL_NAMES));
  });

  it('registers Workflow tools when the beta feature is enabled', () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const tools = createTools(env, {
      workflowBetaEnabled: true,
      platform: {} as PlatformClient,
    });

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(WORKFLOW_TOOL_NAMES),
    );
  });
});
