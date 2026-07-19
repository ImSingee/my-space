import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import viteReact from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const DEFAULT_COUNTER_TEMPLATE_ID = 'virtual:default-counter-template';
const DEFAULT_COUNTER_FIXTURE_ID = '\0default-counter-template-test-fixture';
const DEFAULT_COUNTER_TEMPLATE_PATH = fileURLToPath(
  new URL('./templates/default-app/widgets/counter.tsx', import.meta.url),
);

function defaultCounterTemplateFixture(): Plugin {
  const isDefaultCounterTemplate = (importer: string | undefined) =>
    importer
      ?.split('?')[0]
      .endsWith('/templates/default-app/widgets/counter.tsx') ?? false;

  return {
    name: 'default-counter-template-test-fixture',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === DEFAULT_COUNTER_TEMPLATE_ID) {
        return DEFAULT_COUNTER_TEMPLATE_PATH;
      }
      if (!isDefaultCounterTemplate(importer)) return;
      if (
        source === '../gen/service_pb' ||
        source === '@connectrpc/connect' ||
        source === '@connectrpc/connect-web'
      ) {
        return DEFAULT_COUNTER_FIXTURE_ID;
      }
    },
    load(id) {
      if (id !== DEFAULT_COUNTER_FIXTURE_ID) return;
      return `
        export const CounterService = {};
        export const createConnectTransport = () => ({});
        export const createClient = () =>
          globalThis.__defaultCounterTemplateRpcClient;
      `;
    },
  };
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: {
          tsconfigPaths: true,
        },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
        },
      },
      {
        define: {
          __RPC_BASE_URL__: JSON.stringify('/test-rpc'),
        },
        resolve: {
          tsconfigPaths: true,
        },
        plugins: [defaultCounterTemplateFixture(), viteReact()],
        test: {
          name: 'browser',
          globals: true,
          setupFiles: ['./vitest.browser.setup.ts'],
          include: ['src/**/*.browser.{test,spec}.{ts,tsx}'],
          deps: {
            optimizer: {
              web: {
                enabled: false,
              },
            },
          },
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            headless: true,
            viewport: {
              width: 1280,
              height: 720,
            },
            screenshotFailures: true,
          },
        },
      },
    ],
  },
});
