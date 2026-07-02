import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { afterEach, describe, expect, it } from 'vitest';
import { createTools } from './tools';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeFixture(root: string, filePath: string, content: string) {
  const fullPath = path.join(root, filePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

async function setup(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-tools-'));
  tempRoots.push(root);
  for (const [filePath, content] of Object.entries(files)) {
    await writeFixture(root, filePath, content);
  }
  const env = new NodeExecutionEnv({ cwd: root });
  const tools = createTools(env);
  const getTool = (name: string) => {
    const found = tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`Missing tool ${name}`);
    return found;
  };
  return { root, getTool };
}

function textOf(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('agent file tools', () => {
  it('edits a file with an exact replacement', async () => {
    const { root, getTool } = await setup({
      'src/app.ts': 'const greeting = "hello";\n',
    });

    const result = await getTool('edit_file').execute('edit', {
      path: 'src/app.ts',
      old_string: '"hello"',
      new_string: '"hi"',
    });

    await expect(readFile(path.join(root, 'src/app.ts'), 'utf8')).resolves.toBe(
      'const greeting = "hi";\n',
    );
    expect(textOf(result)).toContain('replaced 1 occurrence');
  });

  it('allows edit_file after write_file creates a file', async () => {
    const { root, getTool } = await setup();

    await getTool('write_file').execute('write', {
      path: 'app.ts',
      content: 'one two\n',
    });
    await getTool('edit_file').execute('edit', {
      path: 'app.ts',
      old_string: 'two',
      new_string: 'three',
    });

    await expect(readFile(path.join(root, 'app.ts'), 'utf8')).resolves.toBe(
      'one three\n',
    );
  });

  it('inserts replacement metacharacters literally', async () => {
    const { root, getTool } = await setup({ 'app.ts': 'value = TOKEN;\n' });

    await getTool('edit_file').execute('edit', {
      path: 'app.ts',
      old_string: 'TOKEN',
      new_string: '$& $$ done',
    });

    await expect(readFile(path.join(root, 'app.ts'), 'utf8')).resolves.toBe(
      'value = $& $$ done;\n',
    );
  });

  it('requires replace_all when old_string matches more than once', async () => {
    const { root, getTool } = await setup({ 'app.ts': 'foo foo\n' });

    await getTool('read_file').execute('read', { path: 'app.ts' });
    await expect(
      getTool('edit_file').execute('edit', {
        path: 'app.ts',
        old_string: 'foo',
        new_string: 'bar',
      }),
    ).rejects.toThrow(/matched 2 times/);

    await getTool('edit_file').execute('edit', {
      path: 'app.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });

    await expect(readFile(path.join(root, 'app.ts'), 'utf8')).resolves.toBe(
      'bar bar\n',
    );
  });

  it('allows symlinked files that resolve inside the workspace', async () => {
    const { root, getTool } = await setup({ 'target.ts': 'const n = 1;\n' });
    await symlink('target.ts', path.join(root, 'link.ts'));

    const readResult = await getTool('read_file').execute('read', {
      path: 'link.ts',
    });
    expect(textOf(readResult)).toBe('const n = 1;\n');

    await getTool('edit_file').execute('edit', {
      path: 'link.ts',
      old_string: '1',
      new_string: '2',
    });

    await expect(readFile(path.join(root, 'target.ts'), 'utf8')).resolves.toBe(
      'const n = 2;\n',
    );
  });

  it('rejects reads outside the workspace', async () => {
    const { root, getTool } = await setup();
    const outsideName = `outside-${path.basename(root)}.txt`;
    const outsidePath = path.join(path.dirname(root), outsideName);
    await writeFile(outsidePath, 'secret');
    try {
      await expect(
        getTool('read_file').execute('read', { path: `../${outsideName}` }),
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('rejects symlinked files that resolve outside the workspace', async () => {
    const { root, getTool } = await setup();
    const outsideName = `outside-${path.basename(root)}.txt`;
    const outsidePath = path.join(path.dirname(root), outsideName);
    await writeFile(outsidePath, 'secret');
    await symlink(outsidePath, path.join(root, 'outside-link.txt'));
    try {
      await expect(
        getTool('read_file').execute('read', { path: 'outside-link.txt' }),
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });
});

describe('run_command sandbox', () => {
  it('runs ordinary commands (wrapped when the sandbox is available)', async () => {
    const { getTool } = await setup();
    const result = await getTool('run_command').execute('cmd', {
      command: 'echo sandbox-ok',
    });
    expect(textOf(result)).toContain('sandbox-ok');
    expect(textOf(result)).toContain('exit code: 0');
  });

  it('denies reading platform env files when the seatbelt is active', async () => {
    const { wrapShellCommand } = await import('./shell-sandbox');
    const { REPO_ROOT } = await import('./paths');
    const envFile = path.join(REPO_ROOT, '.env');
    const seatbeltActive = wrapShellCommand('true') !== 'true';
    if (!seatbeltActive || !existsSync(envFile)) {
      // Non-darwin (container boundary applies) or no .env checked out here.
      return;
    }

    const { getTool } = await setup();
    const result = await getTool('run_command').execute('cmd', {
      command: `cat ${JSON.stringify(envFile)}`,
    });
    const body = textOf(result);
    expect(body).not.toContain('exit code: 0');
    expect(body).toMatch(/Operation not permitted|not permitted/i);
  });
});
