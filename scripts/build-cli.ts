import { chmod, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { resolveBuildInfo } from './build-info';
import { buildCliSkills } from './cli-skills';
import manifest from '../packages/hatch-cli/package.json' with { type: 'json' };

const info = resolveBuildInfo();
const skills = await buildCliSkills(
  fileURLToPath(new URL('../', import.meta.url)),
  manifest.version,
  info.commit,
);

const entry = fileURLToPath(
  new URL('../packages/hatch-cli/src/main.ts', import.meta.url),
);
const output = fileURLToPath(
  new URL('../packages/hatch-cli/dist/main.mjs', import.meta.url),
);

const result = await build({
  define: {
    __HATCH_BUILD_INFO__: JSON.stringify(info),
    __HATCH_SKILL_BUNDLE__: JSON.stringify(skills),
  },
  metafile: true,
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
await chmod(output, 0o755);

for (const input of Object.keys(result.metafile.inputs)) {
  if (/^src\/(server|db|auth|agent)\//.test(input))
    throw new Error(`Server-only module leaked into CLI: ${input}`);
}

// Preserve license notices for every npm package whose code is bundled.
const notices = new Map<string, string>();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    const manifest = await readFile(
      path.join(directory, 'package.json'),
      'utf8',
    ).then(
      (value) => JSON.parse(value) as { name: string; version: string },
      () => null,
    );
    if (manifest?.name) {
      for (const filename of [
        'LICENSE',
        'LICENSE.md',
        'LICENSE.txt',
        'license',
      ]) {
        const license = await readFile(
          path.join(directory, filename),
          'utf8',
        ).catch(() => null);
        if (license) {
          notices.set(`${manifest.name}@${manifest.version}`, license);
          break;
        }
      }
      break;
    }
    directory = path.dirname(directory);
  }
}
const licenseDir = path.join(path.dirname(output), 'licenses');
await mkdir(licenseDir, { recursive: true });
await writeFile(
  path.join(licenseDir, 'third-party.txt'),
  [...notices].map(([name, text]) => `${name}\n${text}`).join('\n\n'),
);
await writeFile(
  path.join(licenseDir, 'Hatch.md'),
  await readFile(new URL('../LICENSE.md', import.meta.url)),
);
