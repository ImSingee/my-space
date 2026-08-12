import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const asyncStep = (name: string) =>
    vi.fn<() => Promise<void>>(async () => {
      events.push(name);
    });
  const step = (name: string) =>
    vi.fn<() => void>(() => {
      events.push(name);
    });
  return {
    events,
    runMigrations: asyncStep('migrations'),
    hardenPlatformDatabase: asyncStep('harden'),
    reconcileActivations: asyncStep('activations'),
    startAgentInternalServer: step('agent-server'),
    sweepExpiredAgentRuns: asyncStep('agent-sweep'),
    ensureAgentRunSweeper: step('agent-sweeper'),
    interruptStaleWorkflowRuns: asyncStep('workflow-interrupt'),
    ensureWorkflowScheduler: step('workflow-scheduler'),
    ensureScheduler: step('app-scheduler'),
    warmLongRunningBackends: asyncStep('backend-warmup'),
    ensureRetentionSweep: step('retention'),
  };
});

vi.mock('nitro', () => ({
  definePlugin: (plugin: () => Promise<void>) => plugin,
}));
vi.mock('~env', () => ({
  getPlatformEnv: () => ({ secret: 'test-platform-secret' }),
}));
vi.mock('~db/migrate.ts', () => ({ runMigrations: mocks.runMigrations }));
vi.mock('~server/agent-runs', () => ({
  ensureAgentRunSweeper: mocks.ensureAgentRunSweeper,
  sweepExpiredAgentRuns: mocks.sweepExpiredAgentRuns,
}));
vi.mock('~server/agent-runner/internal-server', () => ({
  startAgentInternalServer: mocks.startAgentInternalServer,
}));
vi.mock('~server/apps/provision', () => ({
  hardenPlatformDatabase: mocks.hardenPlatformDatabase,
}));
vi.mock('~server/apps/deploy', () => ({
  reconcilePendingAppActivations: mocks.reconcileActivations,
}));
vi.mock('~server/apps/runtime', () => ({
  warmLongRunningBackends: mocks.warmLongRunningBackends,
}));
vi.mock('~server/apps/scheduler', () => ({
  ensureScheduler: mocks.ensureScheduler,
}));
vi.mock('~server/retention', () => ({
  ensureRetentionSweep: mocks.ensureRetentionSweep,
}));
vi.mock('~server/workflows/execute', () => ({
  interruptStaleWorkflowRuns: mocks.interruptStaleWorkflowRuns,
}));
vi.mock('~server/workflows/scheduler', () => ({
  ensureWorkflowScheduler: mocks.ensureWorkflowScheduler,
}));

import migratePlugin from './migrate';

describe('platform startup migrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
  });

  it('recovers pending activations before starting backends', async () => {
    await migratePlugin({} as never);

    expect(mocks.events).toEqual([
      'migrations',
      'harden',
      'activations',
      'agent-server',
      'agent-sweep',
      'agent-sweeper',
      'workflow-interrupt',
      'workflow-scheduler',
      'app-scheduler',
      'backend-warmup',
      'retention',
    ]);
  });
});
