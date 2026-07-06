/**
 * Bundle the Agent Runner service into dist/runner/main.mjs.
 *
 * esbuild bundles our own sources (resolving the `~*` tsconfig alias) but
 * keeps node_modules external — the runner image runs with the same
 * dependency tree as the platform, so there is no need to inline pi-ai etc.
 *
 * Run: pnpm build:runner
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve `~agent/...`, `~server/...`, `~/db/...` etc. to src/. */
const tildeAlias: Plugin = {
  name: 'tilde-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^~/ }, (args) => {
      const sub = args.path.replace(/^~\/?/, '');
      return pluginBuild.resolve(`./${path.posix.join('src', sub)}`, {
        kind: args.kind,
        resolveDir: root,
      });
    });
  },
};

await build({
  entryPoints: [path.join(root, 'src/runner/main.ts')],
  outfile: path.join(root, 'dist/runner/main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  plugins: [tildeAlias],
});
