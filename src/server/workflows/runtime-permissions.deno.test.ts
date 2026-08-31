import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflowDenoArgs } from './runtime-permissions';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('Deno network enforcement', () => {
  it('blocks HTTP, TCP, UDP, DNS, and listeners under an empty policy', async () => {
    const artifactDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hatch-deno-network-'),
    );
    tempDirs.push(artifactDir);
    const programs = {
      http: "await fetch('http://127.0.0.1:45122');\n",
      tcpConnect:
        "await Deno.connect({ hostname: '127.0.0.1', port: 45122 });\n",
      tcpListen: "Deno.listen({ hostname: '127.0.0.1', port: 45123 });\n",
      udpListen:
        "import dgram from 'node:dgram';\n" +
        "dgram.createSocket('udp4').bind(45124, '127.0.0.1');\n" +
        'await new Promise(() => {});\n',
      dns: "await Deno.resolveDns('localhost', 'A');\n",
    };

    for (const [name, source] of Object.entries(programs)) {
      const bundlePath = path.join(artifactDir, `${name}.js`);
      await fs.writeFile(bundlePath, source, 'utf8');
      await expect(
        execFileAsync(
          'deno',
          buildWorkflowDenoArgs({
            artifactDir,
            bundlePath,
            network: [],
          }),
          { cwd: artifactDir },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('NotCapable'),
      });
    }
  });

  it('allows an exact declared target and denies another port', async () => {
    const artifactDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hatch-deno-network-'),
    );
    tempDirs.push(artifactDir);
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to allocate a TCP test port.');
    }
    const allowedPort = address.port;
    const blockedPort =
      allowedPort === 65_535 ? allowedPort - 1 : allowedPort + 1;
    const bundlePath = path.join(artifactDir, 'scoped.js');
    await fs.writeFile(
      bundlePath,
      `const connection = await Deno.connect({ hostname: '127.0.0.1', port: ${allowedPort} });
connection.close();
try {
  await Deno.connect({ hostname: '127.0.0.1', port: ${blockedPort} });
  console.log('allowed');
} catch (error) {
  console.log(error?.name ?? 'unknown');
}
`,
      'utf8',
    );

    try {
      const { stdout } = await execFileAsync(
        'deno',
        buildWorkflowDenoArgs({
          artifactDir,
          bundlePath,
          network: [`127.0.0.1:${allowedPort}`],
        }),
        { cwd: artifactDir },
      );
      expect(stdout.trim()).toBe('NotCapable');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
