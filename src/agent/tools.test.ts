import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
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
import type { EditFileDetails } from './edit-file-details';
import type { PlatformClient } from './platform-client';
import {
  DIFF_TRUNCATION_LINE,
  MAX_EDIT_DETAILS_BYTES,
  MAX_EDIT_DIFF_INPUT_LINES,
} from './tools/edit-diff';
import { createTools } from './tools';

/** These tests only exercise file tools; platform calls must never happen. */
const stubPlatform = new Proxy({} as PlatformClient, {
  get(_target, prop) {
    return () => {
      throw new Error(`PlatformClient.${String(prop)} called in a file test`);
    };
  },
});

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

async function setup(
  files: Record<string, string> = {},
  readOnlyFiles?: Record<string, string>,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'hatch-agent-tools-'));
  tempRoots.push(root);
  for (const [filePath, content] of Object.entries(files)) {
    await writeFixture(root, filePath, content);
  }
  const readOnlyRoot = readOnlyFiles
    ? await mkdtemp(path.join(tmpdir(), 'hatch-agent-resources-'))
    : undefined;
  if (readOnlyRoot) {
    tempRoots.push(readOnlyRoot);
    for (const [filePath, content] of Object.entries(readOnlyFiles ?? {})) {
      await writeFixture(readOnlyRoot, filePath, content);
    }
  }
  const env = new NodeExecutionEnv({ cwd: root });
  const tools = createTools(env, {
    platform: stubPlatform,
    ...(readOnlyRoot ? { readOnlyRoots: [readOnlyRoot] } : {}),
  });
  const getTool = (name: string) => {
    const found = tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`Missing tool ${name}`);
    return found;
  };
  return { root, readOnlyRoot, getTool };
}

function textOf(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function editDetailsOf(result: { details?: unknown }): EditFileDetails {
  return result.details as EditFileDetails;
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
    expect(editDetailsOf(result)).toMatchObject({
      path: 'src/app.ts',
      replacements: 1,
      diff: '-1 const greeting = "hello";\n+1 const greeting = "hi";',
      firstChangedLine: 1,
    });
    expect(editDetailsOf(result).patch).toContain(
      '--- src/app.ts\n+++ src/app.ts\n@@ -1,1 +1,1 @@\n-const greeting = "hello";\n+const greeting = "hi";',
    );
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

    const result = await getTool('edit_file').execute('edit', {
      path: 'app.ts',
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
    });

    await expect(readFile(path.join(root, 'app.ts'), 'utf8')).resolves.toBe(
      'bar bar\n',
    );
    expect(editDetailsOf(result)).toMatchObject({
      path: 'app.ts',
      replacements: 2,
      diff: '-1 foo foo\n+1 bar bar',
      firstChangedLine: 1,
    });
  });

  it('preserves CRLF file contents while returning LF-normalized diffs', async () => {
    const { root, getTool } = await setup({
      'app.ts': 'const one = 1;\r\nconst two = 2;\r\n',
    });

    const result = await getTool('edit_file').execute('edit', {
      path: 'app.ts',
      old_string: 'two = 2',
      new_string: 'two = 3',
    });

    await expect(readFile(path.join(root, 'app.ts'), 'utf8')).resolves.toBe(
      'const one = 1;\r\nconst two = 3;\r\n',
    );
    expect(editDetailsOf(result).diff).toBe(
      ' 1 const one = 1;\n-2 const two = 2;\n+2 const two = 3;',
    );
    expect(editDetailsOf(result).patch).not.toContain('\r');
  });

  it('bounds details for a large single-line edit', async () => {
    const original = `TOKEN${'🙂\\'.repeat(20_000)}`;
    const { root, getTool } = await setup({ 'large.js': original });

    const result = await getTool('edit_file').execute('edit', {
      path: 'large.js',
      old_string: 'TOKEN',
      new_string: 'DONE',
    });
    const details = editDetailsOf(result);

    await expect(readFile(path.join(root, 'large.js'), 'utf8')).resolves.toBe(
      original.replace('TOKEN', 'DONE'),
    );
    expect(
      Buffer.byteLength(JSON.stringify(details), 'utf8'),
    ).toBeLessThanOrEqual(MAX_EDIT_DETAILS_BYTES);
    expect(details).toMatchObject({
      diffTruncated: true,
      patchOmitted: true,
    });
    expect(details.patch).toBeUndefined();
  });

  it('bounds diff computation for a large multi-line replace_all', async () => {
    const lineCount = MAX_EDIT_DIFF_INPUT_LINES / 2;
    const original = 'TOKEN\n'.repeat(lineCount);
    const { root, getTool } = await setup({ 'large.txt': original });

    const result = await getTool('edit_file').execute('edit', {
      path: 'large.txt',
      old_string: 'TOKEN',
      new_string: 'DONE',
      replace_all: true,
    });
    const details = editDetailsOf(result);

    await expect(readFile(path.join(root, 'large.txt'), 'utf8')).resolves.toBe(
      'DONE\n'.repeat(lineCount),
    );
    expect(details).toEqual({
      path: 'large.txt',
      replacements: lineCount,
      diff: DIFF_TRUNCATION_LINE,
      diffTruncated: true,
      patchOmitted: true,
    });
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

  it('reads and lists files inside a configured read-only root', async () => {
    const { getTool, readOnlyRoot } = await setup(
      {},
      {
        'building-apps/SKILL.md': '# Building apps\n',
        'building-apps/references/manifest.md': '# Manifest\n',
      },
    );
    if (!readOnlyRoot) throw new Error('Missing read-only fixture root');

    const skillPath = path.join(readOnlyRoot, 'building-apps', 'SKILL.md');
    const readResult = await getTool('read_file').execute('read', {
      path: skillPath,
    });
    expect(textOf(readResult)).toBe('# Building apps\n');

    const listResult = await getTool('list_files').execute('list', {
      path: path.join(readOnlyRoot, 'building-apps', 'references'),
    });
    expect(textOf(listResult)).toBe('- manifest.md');
  });

  it('rejects symlinks escaping a configured read-only root', async () => {
    const { getTool, readOnlyRoot } = await setup(
      {},
      { 'building-apps/SKILL.md': '# Building apps\n' },
    );
    if (!readOnlyRoot) throw new Error('Missing read-only fixture root');
    const outsidePath = path.join(
      path.dirname(readOnlyRoot),
      `outside-${path.basename(readOnlyRoot)}.txt`,
    );
    await writeFile(outsidePath, 'secret');
    await symlink(
      outsidePath,
      path.join(readOnlyRoot, 'building-apps', 'outside-link.txt'),
    );
    try {
      await expect(
        getTool('read_file').execute('read', {
          path: path.join(readOnlyRoot, 'building-apps', 'outside-link.txt'),
        }),
      ).rejects.toThrow(/outside the workspace/);
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('never writes or edits files in a configured read-only root', async () => {
    const { getTool, readOnlyRoot } = await setup(
      {},
      { 'building-apps/SKILL.md': '# Building apps\n' },
    );
    if (!readOnlyRoot) throw new Error('Missing read-only fixture root');
    const skillPath = path.join(readOnlyRoot, 'building-apps', 'SKILL.md');

    await expect(
      getTool('edit_file').execute('edit', {
        path: skillPath,
        old_string: 'apps',
        new_string: 'workflows',
      }),
    ).rejects.toThrow(/outside the workspace/);
    await expect(
      getTool('write_file').execute('write', {
        path: skillPath,
        content: 'overwritten',
      }),
    ).rejects.toThrow(/outside the workspace/);
    await expect(
      getTool('write_file').execute('write', {
        path: path.join(readOnlyRoot, 'building-apps', 'new.md'),
        content: 'new',
      }),
    ).rejects.toThrow(/outside the workspace/);

    await expect(readFile(skillPath, 'utf8')).resolves.toBe(
      '# Building apps\n',
    );
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
