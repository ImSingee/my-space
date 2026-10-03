import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { devtools } from '@tanstack/devtools-vite';
import { resolvePlatformPort } from './src/platform-port.ts';

// Mirror src/agent/paths.ts: runtime data lives under HATCH_DATA_DIR (default
// `workspace`). Keep it out of the dev watcher so agent writes don't reload.
const dataDir = path.resolve(process.env.HATCH_DATA_DIR ?? 'workspace');

const config = defineConfig(({ mode, isPreview }) => ({
  resolve: {
    alias: {
      tslib: 'tslib/tslib.es6.mjs',
    },
    tsconfigPaths: true,
  },
  server: {
    host: '127.0.0.1',
    port: resolvePlatformPort(
      { ...loadEnv(mode, process.cwd(), ''), ...process.env },
      3700,
    ),
    strictPort: true,
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
  preview: {
    // TanStack Start generates the SPA shell through a Vite preview server.
    // node:26-slim resolves the listener and fetch sides of `localhost` to
    // different IP families, so use an explicit loopback address.
    host: '127.0.0.1',
  },
  plugins: [
    {
      name: 'hatch-platform-port',
      apply: 'serve',
      enforce: 'pre',
      config(config) {
        if (isPreview) return;
        // Vite has merged CLI overrides here. Normalize before Nitro snapshots
        // its environment; its dev plugin also reads PORT for the listener.
        const port = resolvePlatformPort({
          PORT: String(config.server?.port ?? 3700),
        });
        process.env.NITRO_PORT = String(port);
        process.env.PORT = String(port);
        return { server: { port, strictPort: true } };
      },
    },
    devtools(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
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
    plugins: ['src/nitro/plugins/migrate.ts', 'src/nitro/plugins/tailscale.ts'],
  },
}));

export default config;
