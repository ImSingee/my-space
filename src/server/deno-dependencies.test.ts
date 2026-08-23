import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDenoDependencySource } from '../deno-dependencies';

const tempDirs: string[] = [];

function appPackage(extra: Record<string, unknown> = {}) {
  return { type: 'module', ...extra };
}

function appDeno(extra: Record<string, unknown> = {}) {
  return {
    compilerOptions: {
      strict: true,
      jsx: 'react-jsx',
      jsxImportSource: 'react',
    },
    allowScripts: [],
    ...extra,
  };
}

async function source(files: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-deps-test-'));
  tempDirs.push(dir);
  await Promise.all(
    Object.entries(files).map(([name, value]) =>
      fs.writeFile(
        path.join(dir, name),
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8',
      ),
    ),
  );
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('validateDenoDependencySource', () => {
  it('rejects a legacy deno.json-only app and names the correct Skill', async () => {
    const dir = await source({ 'deno.json': { imports: {} } });

    await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
      /Legacy deno\.json-only app.*building-apps.*read_file.*package\.json.*deno\.lock/s,
    );
  });

  it('rejects a legacy deno.json-only workflow and names the correct Skill', async () => {
    const dir = await source({ 'deno.json': { imports: {} } });

    await expect(validateDenoDependencySource(dir, 'workflow')).rejects.toThrow(
      /Legacy deno\.json-only workflow.*building-workflows.*read_file.*package\.json.*deno\.lock/s,
    );
  });

  it('preserves exact reviewed lifecycle packages for Workflows', async () => {
    const dir = await source({
      'package.json': { dependencies: { '@scope/pkg': '^1.2.0' } },
      'deno.json': {
        allowScripts: ['npm:@scope/pkg@1.2.3'],
      },
      'deno.lock': {
        version: '5',
        npm: { '@scope/pkg@1.2.3_peer@4.0.0': { integrity: 'test' } },
      },
    });

    await expect(
      validateDenoDependencySource(dir, 'workflow'),
    ).resolves.toEqual({
      lifecycleScripts: ['npm:@scope/pkg@1.2.3'],
    });
  });

  it('does not apply the fixed standalone App contract to Workflows', async () => {
    const dir = await source({
      'package.json': {
        workspaces: ['../shared'],
        dependencies: { shared: 'file:../shared' },
      },
      'deno.json': { workspace: ['../shared'], allowScripts: [] },
      'deno.lock': { version: '5', npm: {} },
    });

    await expect(
      validateDenoDependencySource(dir, 'workflow'),
    ).resolves.toEqual({ lifecycleScripts: [] });
  });

  it.each([true, ['npm:pkg@^1.2.3']])(
    'rejects broad allowScripts policy %j',
    async (allowScripts) => {
      const dir = await source({
        'package.json': {},
        'deno.json': { allowScripts },
        'deno.lock': { version: '5', npm: { 'pkg@1.2.3': {} } },
      });

      await expect(
        validateDenoDependencySource(dir, 'workflow'),
      ).rejects.toThrow(/allowScripts|Unsafe allowScripts/);
    },
  );

  it('rejects an exact lifecycle package absent from the lock', async () => {
    const dir = await source({
      'package.json': {},
      'deno.json': { allowScripts: ['npm:pkg@1.2.3'] },
      'deno.lock': { version: '5', npm: {} },
    });

    await expect(validateDenoDependencySource(dir, 'workflow')).rejects.toThrow(
      /not present.*deno\.lock/s,
    );
  });

  it('rejects an App-managed Hatch SDK dependency', async () => {
    const dir = await source({
      'package.json': appPackage({
        dependencies: { '@hatch/data': '1.0.0' },
      }),
      'deno.json': appDeno(),
      'deno.lock': { version: '5', npm: {} },
    });

    await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
      /provided by Hatch.*must not be declared.*regenerate deno\.lock/s,
    );
  });

  it('rejects a stale Hatch SDK lock entry', async () => {
    const dir = await source({
      'package.json': appPackage(),
      'deno.json': appDeno(),
      'deno.lock': {
        version: '5',
        specifiers: { 'npm:@hatch/data@1.0.0': '1.0.0' },
        npm: { '@hatch/data@1.0.0': { integrity: 'old' } },
      },
    });

    await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
      /stale App-managed Hatch SDK entry.*deno install/s,
    );
  });

  it.each(['.NPMRC'])(
    'rejects source-controlled npm configuration at %s',
    async (file) => {
      const dir = await source({
        'package.json': appPackage(),
        'deno.json': appDeno(),
        'deno.lock': { version: '5', npm: {} },
        [file]: 'registry=http://127.0.0.1:12345/',
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        /cannot include \.npmrc|cannot include \.NPMRC/i,
      );
    },
  );

  it.each(['deno.jsonc', 'DENO.JSONC', 'tsconfig.json', 'jsconfig.json'])(
    'rejects unsupported root App configuration at %s',
    async (file) => {
      const dir = await source({
        'package.json': appPackage(),
        'deno.json': appDeno(),
        'deno.lock': { version: '5', npm: {} },
        [file]: '{}',
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        new RegExp(`cannot include ${file.replace('.', '\\.')}`, 'i'),
      );
    },
  );

  it.each(['commonjs'])(
    'rejects package.json type %j for an App',
    async (type) => {
      const dir = await source({
        'package.json': type === undefined ? {} : { type },
        'deno.json': appDeno(),
        'deno.lock': { version: '5', npm: {} },
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        /package\.json must declare "type": "module"/,
      );
    },
  );

  it.each(['imports', 'scopes', 'importMap'])(
    'rejects deno.json %s for an App',
    async (key) => {
      const dir = await source({
        'package.json': appPackage(),
        'deno.json': appDeno({ [key]: {} }),
        'deno.lock': { version: '5', npm: {} },
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        new RegExp(`deno\\.json must not declare ${key}`),
      );
    },
  );

  it.each([
    ['strict', { strict: false, jsx: 'react-jsx', jsxImportSource: 'react' }],
    ['jsx', { strict: true, jsx: 'preserve', jsxImportSource: 'react' }],
    [
      'jsxImportSource',
      { strict: true, jsx: 'react-jsx', jsxImportSource: 'preact' },
    ],
  ])(
    'rejects a non-platform compilerOptions.%s',
    async (key, compilerOptions) => {
      const dir = await source({
        'package.json': appPackage(),
        'deno.json': appDeno({ compilerOptions }),
        'deno.lock': { version: '5', npm: {} },
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        new RegExp(`compilerOptions\\.${key}`),
      );
    },
  );

  it('accepts the fixed App ESM and compiler configuration', async () => {
    const dir = await source({
      'package.json': appPackage(),
      'deno.json': appDeno({ allowScripts: undefined }),
      'deno.lock': { version: '5', npm: {} },
    });

    await expect(validateDenoDependencySource(dir, 'app')).resolves.toEqual({
      lifecycleScripts: [],
    });
  });

  it('rejects every non-empty App lifecycle approval before lock inspection', async () => {
    const dir = await source({
      'package.json': appPackage(),
      'deno.json': appDeno({ allowScripts: ['npm:pkg@1.2.3'] }),
      'deno.lock': { version: '5', npm: { 'pkg@1.2.3': {} } },
    });

    await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
      /allowScripts must be absent or an empty array/,
    );
  });

  it.each(['file:../shared', 'workspace:*', '/tmp/shared'])(
    'rejects local dependency specifier %s',
    async (specifier) => {
      const dir = await source({
        'package.json': appPackage({ dependencies: { shared: specifier } }),
        'deno.json': appDeno(),
        'deno.lock': { version: '5', npm: {} },
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        /must deploy as standalone trees.*registry version/s,
      );
    },
  );

  it.each([
    ['package.json workspaces', { workspaces: ['../shared'] }, {}],
    ['deno.json workspace', {}, { workspace: ['../shared'] }],
  ])('rejects %s', async (_label, packageExtra, denoExtra) => {
    const dir = await source({
      'package.json': appPackage(packageExtra),
      'deno.json': appDeno(denoExtra),
      'deno.lock': { version: '5', npm: {} },
    });

    await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
      /must be standalone.*workspace members/s,
    );
  });
});
