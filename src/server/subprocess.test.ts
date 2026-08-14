import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from './subprocess';

const tempDirs: string[] = [];

async function eventuallyNotRunning(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform !== 'win32')('run process groups', () => {
  it('kills descendants when the direct child exits normally', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-run-test-'));
    tempDirs.push(root);
    const pidFile = path.join(root, 'descendant.pid');
    const descendant = 'setInterval(() => {}, 1_000);';
    const parent =
      `const { spawn } = require('node:child_process');` +
      `const { writeFileSync } = require('node:fs');` +
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        descendant,
      )}], { stdio: 'ignore' });` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      `child.unref();`;

    const result = await run(process.execPath, ['-e', parent], {
      cwd: root,
      timeoutMs: 2_000,
    });

    expect(result.code).toBe(0);
    const descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(await eventuallyNotRunning(descendantPid)).toBe(true);
  });

  it('kills the complete process group on timeout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-run-test-'));
    tempDirs.push(root);
    const pidFile = path.join(root, 'descendant.pid');
    const descendant = 'setInterval(() => {}, 1_000);';
    const parent =
      `const { spawn } = require('node:child_process');` +
      `const { writeFileSync } = require('node:fs');` +
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        descendant,
      )}], { stdio: 'ignore' });` +
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));` +
      `setInterval(() => {}, 1_000);`;

    const result = await run(process.execPath, ['-e', parent], {
      cwd: root,
      timeoutMs: 250,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain('timed out after 250ms');
    const descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(await eventuallyNotRunning(descendantPid)).toBe(true);
  });
});
