import { describe, expect, it } from 'vitest';
import {
  extraPermissionsSchema,
  extraPermissionsView,
  mergeDenoPermissionFlags,
} from './extra-permissions';
import { effectiveNetworkAccessView } from './network-policy';

describe('extra Deno permission contract', () => {
  it('merges scopes in stable first-seen order and lets bare permissions win', () => {
    expect(
      mergeDenoPermissionFlags(
        ['--allow-read=/a', '--allow-net=one:443', '--allow-env'],
        [
          '--allow-read=/b,/a',
          '--allow-net',
          '--allow-env=HOME',
          '--allow-run=echo',
          '--allow-run=git,echo',
          '--allow-sys=hostname',
        ],
      ),
    ).toEqual([
      '--allow-read=/a,/b',
      '--allow-net',
      '--allow-env',
      '--allow-run=echo,git',
      '--allow-sys=hostname',
    ]);
    expect(
      mergeDenoPermissionFlags(['--allow-read'], ['--allow-read=/a']),
    ).toEqual(['--allow-read']);
    expect(
      mergeDenoPermissionFlags(['--allow-read=/a'], ['--allow-read']),
    ).toEqual(['--allow-read']);
  });

  it('collapses all permissions when allow-all occurs on either side', () => {
    expect(
      mergeDenoPermissionFlags(
        ['--allow-env'],
        ['--allow-all', '--allow-run=echo'],
      ),
    ).toEqual(['--allow-all']);
    expect(mergeDenoPermissionFlags(['--allow-all'], ['--allow-net'])).toEqual([
      '--allow-all',
    ]);
  });

  it('retains Deno-owned validation and deduplicates declarations', () => {
    expect(
      extraPermissionsSchema.parse([
        '--allow-foo',
        '--allow-sys=bogus',
        '--allow-foo',
      ]),
    ).toEqual(['--allow-foo', '--allow-sys=bogus']);
  });

  it('projects host risks and effective network overrides', () => {
    for (const flag of [
      '--allow-all',
      '--allow-run=echo',
      '--allow-ffi=/x',
      '--allow-read',
      '--allow-write',
      '--allow-env',
    ]) {
      expect(extraPermissionsView([flag])).toEqual({
        flags: [flag],
        hostAccess: true,
      });
    }
    expect(
      extraPermissionsView(['--allow-read=/x', '--allow-net']).hostAccess,
    ).toBe(false);
    expect(extraPermissionsView()).toEqual({ flags: [], hostAccess: false });
    for (const flag of ['--allow-all', '--allow-net']) {
      expect(effectiveNetworkAccessView([], [flag])).toEqual({
        mode: 'unrestricted',
        destinations: [],
        legacy: false,
      });
    }
    expect(
      effectiveNetworkAccessView(['one:443'], ['--allow-net=two:443,one:443']),
    ).toEqual({
      mode: 'restricted',
      destinations: ['one:443', 'two:443'],
      legacy: false,
    });
    expect(effectiveNetworkAccessView([], ['--allow-net=one:443']).mode).toBe(
      'restricted',
    );
    expect(
      effectiveNetworkAccessView(undefined, ['--allow-net=one:443']).mode,
    ).toBe('unrestricted');
  });
});
