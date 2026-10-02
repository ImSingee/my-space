// Both SDKs ship declarations from the same canonical manifest contracts.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

for (const target of [
  'packages/hatch-app/dist',
  'packages/hatch-workflow/dist/manifest',
]) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp('packages/hatch-manifest/dist', target, { recursive: true });
  for (const entry of (await readdir(target))
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(0, -3))) {
    const file = `${target}/${entry}.js`;
    const source = await readFile(file, 'utf8');
    await writeFile(file, `// @ts-self-types="./${entry}.d.ts"\n${source}`);
  }
}
