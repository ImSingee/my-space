import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDenoDependencySource } from './deno-dependencies';

const tempDirs: string[] = [];

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

  it('accepts exact reviewed lifecycle packages present in the lock', async () => {
    const dir = await source({
      'package.json': { dependencies: { '@scope/pkg': '^1.2.0' } },
      'deno.json': { allowScripts: ['npm:@scope/pkg@1.2.3'] },
      'deno.lock': {
        version: '5',
        npm: { '@scope/pkg@1.2.3_peer@4.0.0': { integrity: 'test' } },
      },
    });

    await expect(
      validateDenoDependencySource(dir, 'app'),
    ).resolves.toBeUndefined();
  });

  it.each([true, ['npm:pkg@^1.2.3'], ['npm:pkg'], ['npm:pkg@latest']])(
    'rejects broad allowScripts policy %j',
    async (allowScripts) => {
      const dir = await source({
        'package.json': {},
        'deno.json': { allowScripts },
        'deno.lock': { version: '5', npm: { 'pkg@1.2.3': {} } },
      });

      await expect(validateDenoDependencySource(dir, 'app')).rejects.toThrow(
        /allowScripts|Unsafe allowScripts/,
      );
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
});
