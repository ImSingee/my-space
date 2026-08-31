import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findWorkflow:
    vi.fn<
      (options?: unknown) => Promise<Record<string, unknown> | undefined>
    >(),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder = {
      middleware: () => builder,
      validator: (next: (value: never) => unknown) => {
        validate = (value) => next(value as never);
        return builder;
      },
      handler:
        (handler: (context: { data: never }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) as never }),
    };
    return builder;
  },
}));

vi.mock('~/db', () => ({
  db: {
    query: {
      workflows: { findFirst: mocks.findWorkflow },
    },
  },
}));

vi.mock('./auth', () => ({ authMiddleware: {} }));

const { getWorkflowBySlug } = await import('./workflows');

const row = {
  id: '01immutableworkflow',
  slug: 'human-readable-slug',
  name: 'Example workflow',
  description: null,
  status: 'deployed',
  pinned: true,
  currentDeploymentId: 'deployment-one',
  currentSourceCommit: 'commit-one',
  inputSchema: {},
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T01:00:00.000Z'),
};

describe('Workflow human route lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findWorkflow.mockImplementation(async (options) => {
      const where = (options as { where?: { slug?: string } } | undefined)
        ?.where;
      return where?.slug === row.slug ? row : undefined;
    });
  });

  it('loads detail strictly by the mutable slug', async () => {
    await expect(
      getWorkflowBySlug({ data: 'human-readable-slug' }),
    ).resolves.toEqual({
      ...row,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T01:00:00.000Z',
    });
    expect(mocks.findWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'human-readable-slug' } }),
    );
  });

  it('does not fall back from a slug path to immutable id lookup', async () => {
    await expect(
      getWorkflowBySlug({ data: '01immutableworkflow' }),
    ).resolves.toBeNull();
    expect(mocks.findWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: '01immutableworkflow' } }),
    );
  });
});
