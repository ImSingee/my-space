import path from 'node:path';
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { devtools } from '@tanstack/devtools-vite';

// Mirror src/agent/paths.ts: runtime data lives under HATCH_DATA_DIR (default
// `workspace`). Keep it out of the dev watcher so agent writes don't reload.
const dataDir = path.resolve(process.env.HATCH_DATA_DIR ?? 'workspace');

const config = defineConfig({
  resolve: {
    alias: {
      tslib: 'tslib/tslib.es6.mjs',
    },
    tsconfigPaths: true,
  },
  server: {
    watch: {
      // The Agent constantly writes app source, build output, Git repos, and
      // artifacts under workspace/ while scaffolding and deploying apps. Vite
      // treats the generated app/index.html files as HTML entries and fires a
      // full page reload on each write, which reloads the host page mid-run and
      // interrupts the live agent stream (losing the half-streamed reply). These
      // are runtime data, not source, so keep them out of the dev file watcher.
      // (Vite appends this to its built-in ignores like node_modules and .git.)
      ignored: ['**/workspace/**', path.join(dataDir, '**')],
    },
  },
  plugins: [
    devtools(),
    tanstackStart(),
    nitro({
      noExternals: true,
      // esbuild's Node API locates its native binary relative to its own
      // CommonJS module. Bundling it into Nitro's ESM output removes the
      // __filename/__dirname globals it relies on, so keep this one runtime
      // dependency external. The production image already ships node_modules.
      rollupConfig: { external: ['esbuild'] },
    }),
    viteReact(),
  ],
  nitro: {
    output: {
      dir: 'dist/platform',
    },
    plugins: ['src/nitro/plugins/migrate.ts'],
  },
});

export default config;
