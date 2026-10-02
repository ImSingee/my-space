/** Exercise a rendered scaffold through the production manifest loader. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeAppHatchSdk,
  materializeWorkflowHatchSdk,
} from './agent/hatch-sdk';
import { loadSourceManifest, manifestRunner } from './source-manifest';
import { parseSourceManifest } from './server/apps/manifest';
import { parseSourceWorkflowManifest } from './server/workflows/manifest';

export async function evaluateTemplateManifest(
  source: string,
  kind: 'app' | 'workflow',
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'template-manifest-'));
  try {
    for (const file of ['package.json', 'deno.json', 'deno.lock']) {
      await fs.copyFile(
        path.resolve(`templates/default-${kind}`, file),
        path.join(root, file),
      );
    }
    await fs.writeFile(path.join(root, 'manifest.ts'), source);
    await (
      kind === 'app' ? materializeAppHatchSdk : materializeWorkflowHatchSdk
    )(root);
    const install = await manifestRunner(root)(
      [
        'install',
        '--package-json',
        '--node-modules-dir=auto',
        '--lock=deno.lock',
        '--frozen',
      ],
      {},
    );
    if (install.code !== 0) throw new Error(install.output);
    return (
      await loadSourceManifest(root, {
        kind,
        parse: (raw) =>
          kind === 'app'
            ? parseSourceManifest(raw)
            : parseSourceWorkflowManifest(raw),
      })
    ).manifest;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
