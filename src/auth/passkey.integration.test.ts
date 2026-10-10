import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from 'playwright';
import { createServer, type Connect, type ViteDevServer } from 'vite';
import viteReact from '@vitejs/plugin-react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';

const fixture = vi.hoisted(() => ({
  close: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  const database = await createTestDb();
  fixture.close = () => database.db.$client.close();
  return database;
});

const { db, schema } = await import('~/db');
let server: ViteDevServer;
let cacheDir: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let authenticatorId: string;
let origin: string;
let handleAuth: (request: Request) => Promise<Response>;
type ApiResult = { error: { code?: string; message: string } | null };

// Serve the production component, SDK and auth handler together. Only the
// authenticator and database are virtual; HTTP cookies and ceremonies are real.
const html = `<!doctype html><html><body>
  <div id="root"></div><script type="module">
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { MantineProvider } from '@mantine/core';
  import { PasskeySignIn } from '/src/components/auth/passkey-sign-in.tsx';
  import { authClient } from '/src/auth/client.ts';
  import { Toaster } from 'sonner';
  const root = createRoot(document.getElementById('root'));
  const get = navigator.credentials.get.bind(navigator.credentials);
  window.ceremonies = [];
  navigator.credentials.get = (options) => {
    window.ceremonies.push(options.mediation || 'explicit');
    return get(options);
  };
  window.client = authClient;
  window.navigationAttempts = 0;
  window.navigationFailures = 0;
  window.register = () => window.client.passkey.addPasskey({ name: 'Regression key' });
  window.mount = () => root.render(React.createElement(MantineProvider, {},
    React.createElement(React.Fragment, {}, React.createElement(Toaster),
    React.createElement(PasskeySignIn, { appOrigin: location.origin,
      onSuccess: async () => {
        window.navigationAttempts++;
        if (window.navigationFailures-- > 0) throw new Error('Route unavailable');
        window.signedIn = true;
      }
    }))));
  window.ready = true;
  </script></body></html>`;

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'hatch-passkey-regression-'));
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    try {
      if (req.url?.startsWith('/api/auth/')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const response = await handleAuth(
          new Request(`${origin}${req.url}`, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            ...(body.length ? { body } : {}),
          }),
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') res.setHeader(key, value);
        });
        res.setHeader('set-cookie', response.headers.getSetCookie());
        res.end(Buffer.from(await response.arrayBuffer()));
      } else if (req.url === '/__passkey_regression') {
        res.setHeader('content-type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, html));
      } else next();
    } catch (error) {
      next(error as Error);
    }
  };
  server = await createServer({
    configFile: false,
    cacheDir,
    resolve: { tsconfigPaths: true },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom/client',
        '@mantine/core',
        '@better-auth/passkey/client',
        'better-auth/react',
        '@tabler/icons-react',
        'sonner',
      ],
    },
    plugins: [
      viteReact(),
      {
        name: 'passkey-regression-fixture',
        configureServer(vite) {
          vite.middlewares.use(middleware);
        },
      },
    ],
    // This is an immutable test fixture, not a live editing surface. HMR can
    // otherwise remount the login component during concurrent repo checks.
    server: { host: 'localhost', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  origin = `http://localhost:${(server.httpServer!.address() as AddressInfo).port}`;
  console.info(`Passkey regression fixture: ${origin}/__passkey_regression`);
  vi.stubEnv('APP_URL', origin);
  vi.stubEnv('SECRET', 'passkey-regression-secret-at-least-32-characters');
  vi.stubEnv('AGENT_RUNNER_TOKEN', 'passkey-regression-runner');
  const { auth } = await import('./server');
  handleAuth = (request) => auth.handler(request);
  browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => {
  await db.delete(schema.user);
  await db.delete(schema.verification);
  context = await browser.newContext();
  page = await context.newPage();
  page.on('pageerror', (error) => console.error(error));
  await page.goto(`${origin}/__passkey_regression`);
  await page.waitForFunction('window.ready === true');
  cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  const signup = await page.evaluate<ApiResult>(`window.client.signUp.email({
    name: 'Owner', email: 'passkey@example.test', password: 'passkey-regression-password'
  })`);
  if (signup.error) throw new Error(JSON.stringify(signup.error));
}, 30_000);

afterEach(async () => {
  await context?.close();
});
afterAll(async () => {
  await browser?.close();
  // Fault-injection requests may leave HTTP connections open. Teardown must
  // close fixture-owned sockets instead of waiting for their idle timeout.
  const httpServer = server?.httpServer;
  if (httpServer && 'closeAllConnections' in httpServer) {
    httpServer.closeAllConnections();
  }
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  await fixture.close?.();
  vi.unstubAllEnvs();
}, 30_000);

async function enrollAndOpenLogin() {
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).toBeNull();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].isResidentCredential).toBe(true);
  await page.evaluate('window.client.signOut()');
}

async function completeNativeAuthentication() {
  await page.waitForFunction('window.signedIn === true');
  const session = await page.evaluate<{ data: { user: { email: string } } }>(
    'window.client.getSession()',
  );
  expect(session.data.user.email).toBe('passkey@example.test');
}

test('retries navigation after SDK authentication without another ceremony or session', async () => {
  await enrollAndOpenLogin();
  await page.evaluate('window.navigationFailures = 2; window.mount()');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.waitForFunction('window.navigationAttempts === 1');
  await page.getByText(/Signed in, but the next page/).waitFor();
  const initialSession = await page.evaluate<{
    data: { session: { id: string } };
  }>('window.client.getSession()');
  expect(initialSession.data.session.id).toBeTruthy();
  const retry = page.getByRole('button', { name: 'Continue', exact: true });
  await retry.click();
  await page.waitForFunction('window.navigationAttempts === 2');
  await expect.poll(() => retry.isEnabled()).toBe(true);
  await retry.click();
  await completeNativeAuthentication();
  expect(await page.evaluate('window.navigationAttempts')).toBe(3);
  expect(await page.evaluate('window.ceremonies')).toEqual(['explicit']);
  const session = await page.evaluate<{ data: { session: { id: string } } }>(
    'window.client.getSession()',
  );
  expect(session.data.session.id).toBe(initialSession.data.session.id);
}, 20_000);

test('does not request a challenge on mount, focus, or network restoration', async () => {
  await enrollAndOpenLogin();
  let optionsRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/passkey/generate-authenticate-options'))
      optionsRequests++;
  });
  await page.clock.install();
  await page.evaluate('window.mount()');
  const button = page.getByRole('button', { name: 'Sign in with a passkey' });
  await button.waitFor();
  await page.clock.fastForward(301_000);
  await page.evaluate(`window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));`);
  expect(optionsRequests).toBe(0);
  expect(await page.evaluate('window.ceremonies')).toEqual([]);
  await button.click();
  await completeNativeAuthentication();
  expect(optionsRequests).toBe(1);
  expect(await page.evaluate('window.ceremonies')).toEqual(['explicit']);
}, 20_000);

test('reports a transient options failure and retries through the official SDK', async () => {
  await enrollAndOpenLogin();
  let first = true;
  await page.route('**/passkey/generate-authenticate-options', (route) => {
    if (!first) return route.continue();
    first = false;
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Please try again',
      }),
    });
  });
  await page.evaluate('window.mount()');
  const button = page.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();
  await page.getByText('Please try again', { exact: true }).waitFor();
  await expect.poll(() => button.isEnabled()).toBe(true);
  expect(await page.evaluate('window.signedIn === true')).toBe(false);
  await button.click();
  await completeNativeAuthentication();
}, 20_000);

test('keeps a dismissed native prompt silent and permits another SDK ceremony', async () => {
  await enrollAndOpenLogin();
  await page.evaluate(`(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    let first = true;
    navigator.credentials.get = (options) => {
      if (!first) return get(options);
      first = false;
      return Promise.reject(new DOMException('Cancelled', 'NotAllowedError'));
    };
    window.mount();
  })()`);
  const button = page.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();
  await expect.poll(() => button.isEnabled()).toBe(true);
  expect(await page.locator('[data-sonner-toast]').count()).toBe(0);
  expect(await page.evaluate('window.signedIn === true')).toBe(false);
  await button.click();
  await completeNativeAuthentication();
}, 20_000);

test('an older valid session can complete native passkey enrollment', async () => {
  await db.update(schema.session).set({
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000),
  });
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).toBeNull();
  await expect(db.select().from(schema.passkey)).resolves.toHaveLength(1);
});

test('rejects enrollment on authenticators without resident credential support', async () => {
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: false,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }));
  await page.route('**/passkey/generate-register-options*', async (route) => {
    const response = await route.fetch();
    const options = await response.json();
    await route.fulfill({ response, json: { ...options, timeout: 1_000 } });
  });
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).not.toBeNull();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  expect(credentials).toHaveLength(0);
  await expect(db.select().from(schema.passkey)).resolves.toEqual([]);
}, 15_000);
