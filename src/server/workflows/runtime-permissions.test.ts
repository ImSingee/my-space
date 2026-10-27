import { describe, expect, it } from 'vitest';
import { buildWorkflowDenoArgs } from './runtime-permissions';

const base = {
  bundlePath: '/artifacts/workflow.js',
  artifactDir: '/artifacts',
};

describe('workflow Deno network permissions', () => {
  it('keeps legacy deployments unrestricted without changing resolution', () => {
    expect(buildWorkflowDenoArgs(base)).toEqual([
      'run',
      '--allow-net',
      '--allow-env',
      '--allow-read=/artifacts',
      '--no-prompt',
      '/artifacts/workflow.js',
    ]);
  });

  it('blocks all network access for an empty declaration', () => {
    const args = buildWorkflowDenoArgs({ ...base, network: [] });
    expect(args).not.toContain('--allow-net');
    expect(args).toContain('--no-config');
    expect(args).toContain('--no-lock');
    expect(args).toContain('--no-npm');
    expect(args).toContain('--no-remote');
    expect(args).toContain('--cached-only');
  });

  it('scopes every network API to declared destinations', () => {
    expect(
      buildWorkflowDenoArgs({
        ...base,
        network: ['api.example.com:443', '10.0.0.8:5432'],
      }),
    ).toContain('--allow-net=api.example.com:443,10.0.0.8:5432');
  });

  it('supports an explicit unrestricted declaration with bundle isolation', () => {
    const args = buildWorkflowDenoArgs({
      ...base,
      network: 'unrestricted',
    });
    expect(args).toContain('--allow-net');
    expect(args).toContain('--no-config');
    expect(args).toContain('--cached-only');
  });
});

describe('workflow extra permission merging', () => {
  it('broadens platform scopes and unions declared scopes', () => {
    const args = buildWorkflowDenoArgs({
      ...base,
      network: ['one:443'],
      extraPermissions: ['--allow-read', '--allow-net', '--allow-run=echo'],
    });
    expect(args).toContain('--allow-read');
    expect(args).toContain('--allow-net');
    expect(args).toContain('--allow-run=echo');
    expect(args).not.toContain('--allow-read=/artifacts');
    expect(args).not.toContain('--allow-net=one:443');
    expect(
      buildWorkflowDenoArgs({
        ...base,
        network: ['one:443'],
        extraPermissions: ['--allow-net=two:443'],
      }),
    ).toContain('--allow-net=one:443,two:443');
  });
  it('starts allow-all without other allow flags', () => {
    const args = buildWorkflowDenoArgs({
      ...base,
      network: [],
      extraPermissions: ['--allow-all'],
    });
    expect(args.filter((arg) => arg.startsWith('--allow-'))).toEqual([
      '--allow-all',
    ]);
  });
});
