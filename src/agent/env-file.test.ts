import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseEnvFile,
  readEnvFile,
  serializeEnvFile,
  writeEnvFile,
} from './env-file';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const localRequire = createRequire(import.meta.url);
const viteRequire = createRequire(localRequire.resolve('vite/package.json'));
const dotenv = viteRequire('dotenv') as {
  parse(contents: string): Record<string, string>;
};

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'hatch-env-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe('.env storage', () => {
  it('round-trips dotenv values and writes a stable 0600 file', async () => {
    const workDir = await root();
    const values = new Map([
      [
        'Z_TOKEN',
        ` spaces $dollar "double" 'single' \\ slash # hash literal\\n `,
      ],
      ['Q_TOKEN', "single ' and `backtick` plus \\ slash $dollar # hash"],
      ['RAW_TOKEN', 'a\'"`b'],
      ['A_TOKEN', 'first'],
      ['EMPTY', ''],
    ]);

    await writeEnvFile(
      workDir,
      [...values].map(([key, value], index) => ({
        key,
        value,
        secret: index % 2 === 0,
      })),
    );

    const filePath = path.join(workDir, '.env');
    const output = await readFile(filePath, 'utf8');
    expect(await readEnvFile(workDir)).toEqual(values);
    expect(output).toBe(serializeEnvFile(values));
    expect(dotenv.parse(output)).toEqual(Object.fromEntries(values));
    expect(output).toContain("A_TOKEN='first'");
    expect(output).toContain('Q_TOKEN="single');
    expect(output).toContain('RAW_TOKEN=a\'"`b\n');
    expect(output).toContain('Z_TOKEN=` spaces');
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, 'utf8')).toMatch(/^A_TOKEN=/);
  });

  it('merges keys, overwrites one key, and serializes concurrent updates', async () => {
    const workDir = await root();
    await writeEnvFile(workDir, [
      { key: 'FIRST', value: 'old' },
      { key: 'KEEP', value: 'keep' },
    ]);
    await Promise.all([
      writeEnvFile(workDir, [{ key: 'FIRST', value: 'new', secret: true }]),
      writeEnvFile(workDir, [
        { key: 'SECOND', value: 'second', secret: false },
      ]),
    ]);

    expect(Object.fromEntries(await readEnvFile(workDir))).toEqual({
      FIRST: 'new',
      KEEP: 'keep',
      SECOND: 'second',
    });
  });

  it('rejects symlink and non-regular targets without changing the target', async () => {
    const workDir = await root();
    const outside = path.join(await root(), 'outside');
    await writeFile(outside, 'untouched');
    await symlink(outside, path.join(workDir, '.env'));

    await expect(
      writeEnvFile(workDir, [{ key: 'TOKEN', value: 'canary' }]),
    ).rejects.toThrow(/regular file/);
    await expect(readFile(outside, 'utf8')).resolves.toBe('untouched');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a FIFO target without blocking',
    async () => {
      const workDir = await root();
      await execFileAsync('mkfifo', [path.join(workDir, '.env')]);

      await expect(readEnvFile(workDir)).rejects.toThrow(/regular file/);
    },
  );

  it('rejects an oversized existing file before parsing it', async () => {
    const workDir = await root();
    const filePath = path.join(workDir, '.env');
    await writeFile(filePath, Buffer.alloc(1024 * 1024 + 1, 0x61), {
      mode: 0o600,
    });

    await expect(readEnvFile(workDir)).rejects.toThrow(/too large/);
  });

  it('rejects malformed UTF-8 without replacing or rewriting it', async () => {
    const workDir = await root();
    const filePath = path.join(workDir, '.env');
    const invalid = Buffer.from([0x54, 0x4f, 0x4b, 0x45, 0x4e, 0x3d, 0xff]);
    await writeFile(filePath, invalid, { mode: 0o600 });

    await expect(readEnvFile(workDir)).rejects.toThrow(/valid UTF-8/);
    await expect(
      writeEnvFile(workDir, [{ key: 'OTHER', value: 'safe' }]),
    ).rejects.toThrow(/valid UTF-8/);
    await expect(readFile(filePath)).resolves.toEqual(invalid);
  });

  it('rejects an Agent-controlled ancestor symlink', async () => {
    const base = await root();
    const agents = path.join(base, 'agents');
    const external = path.join(base, 'external');
    await mkdir(agents);
    await mkdir(path.join(external, 'work'), { recursive: true });
    await symlink(external, path.join(agents, 'session'));

    await expect(
      writeEnvFile(path.join(agents, 'session', 'work'), [
        { key: 'TOKEN', value: 'canary' },
      ]),
    ).rejects.toThrow(/must not contain symlinks/);
    await expect(access(path.join(external, 'work', '.env'))).rejects.toThrow(
      /ENOENT|no such file/,
    );
  });

  it('removes abandoned writer temp files before an atomic update', async () => {
    const workDir = await root();
    const stale = path.join(
      workDir,
      '.env.00000000-0000-4000-8000-000000000000.tmp',
    );
    const unrelated = path.join(workDir, '.env.keep.tmp');
    await writeFile(stale, 'stale');
    await writeFile(unrelated, 'keep');

    await writeEnvFile(workDir, [{ key: 'TOKEN', value: 'value' }]);

    await expect(access(stale)).rejects.toThrow(/ENOENT|no such file/);
    await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep');
  });

  it('preserves an existing file when parsing or writing fails', async () => {
    const workDir = await root();
    const filePath = path.join(workDir, '.env');
    await writeFile(filePath, 'BROKEN=unquoted\n');
    await chmod(filePath, 0o600);

    await expect(
      writeEnvFile(workDir, [{ key: 'TOKEN', value: 'value' }]),
    ).rejects.toThrow(/non-canonical value encoding/);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('BROKEN=unquoted\n');
  });

  it('rejects non-canonical and unrepresentable values without leaking them', () => {
    expect(() => parseEnvFile('TOKEN="ok"\n')).toThrow(/non-canonical/);
    const value = `canary $ "double" 'single' \\ slash # hash literal\\n \`tick\``;
    let thrown: unknown;
    try {
      serializeEnvFile(new Map([['TOKEN', value]]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Environment value for "TOKEN" cannot be represented safely in canonical dotenv.',
    );
    expect((thrown as Error).message).not.toContain('canary');
  });

  it('rejects malformed entries without including their values in errors', () => {
    expect(() => parseEnvFile("TOKEN='ok'\nTOKEN='second'\n")).toThrow(
      /duplicate key "TOKEN"/,
    );
    expect(() => serializeEnvFile(new Map([['TOKEN', 'value']]))).not.toThrow();

    for (const value of [
      'canary\0suffix',
      'canary\nsuffix',
      'canary\rsuffix',
      'canary\ud800suffix',
      'canary\udfffsuffix',
      'x'.repeat(16 * 1024 + 1),
    ]) {
      let thrown: unknown;
      try {
        serializeEnvFile(new Map([['TOKEN', value]]));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(
        'Environment value for "TOKEN" is invalid.',
      );
      expect((thrown as Error).message).not.toContain('canary');
    }
  });
});
