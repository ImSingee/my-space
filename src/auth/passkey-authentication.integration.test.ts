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
  <input autocomplete="username webauthn" aria-label="Email" />
  <div id="root"></div><script type="module">
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { MantineProvider } from '@mantine/core';
  import { PasskeySignIn } from '/src/components/auth/passkey-sign-in.tsx';
  import { authClient } from '/src/auth/client.ts';
  import { startRegistration } from '@simplewebauthn/browser';
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
  window.register = async () => {
    const options = await authClient.$fetch('/passkey/generate-register-options');
    options.data.timeout = 1000;
    try {
      const response = await startRegistration({ optionsJSON: options.data });
      return await authClient.$fetch('/passkey/verify-registration', {
        method: 'POST', body: { response, name: 'Regression key' }
      });
    } catch (error) { return { error: { code: error.code, message: error.message } }; }
  };
  window.mount = () => root.render(React.createElement(MantineProvider, {},
    React.createElement(React.Fragment, {}, React.createElement(Toaster),
    React.createElement(PasskeySignIn, { appOrigin: location.origin,
      onSuccess: async () => {
        window.navigationAttempts++;
        if (window.navigationFailures-- > 0) throw new Error('Route unavailable');
        window.signedIn = true;
      }
    }))));
  window.unmount = () => root.unmount();
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
        '@simplewebauthn/browser',
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

async function enrollAndOpenLogin(presence = true) {
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).toBeNull();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].isResidentCredential).toBe(true);
  await page.evaluate('window.client.signOut()');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId,
    enabled: presence,
  });
}

async function completeNativeAuthentication() {
  await page.waitForFunction('window.signedIn === true');
  const session = await page.evaluate<{ data: { user: { email: string } } }>(
    'window.client.getSession()',
  );
  expect(session.data.user.email).toBe('passkey@example.test');
}

test.each(['explicit', 'conditional'])(
  'retries navigation after %s authentication without another ceremony or session',
  async (mediation) => {
    await enrollAndOpenLogin();
    await page.evaluate((conditional) => {
      PublicKeyCredential.isConditionalMediationAvailable = async () =>
        conditional;
    }, mediation === 'conditional');
    await page.evaluate('window.navigationFailures = 2; window.mount()');
    if (mediation === 'explicit') {
      await page
        .getByRole('button', { name: 'Sign in with a passkey' })
        .click();
    }
    await page.waitForFunction('window.navigationAttempts === 1');
    await page.getByText(/Signed in, but the next page/).waitFor();
    const initialSession = await page.evaluate<{
      data: { session: { id: string } };
    }>('window.client.getSession()');
    expect(initialSession.data.session.id).toBeTruthy();
    const retry = page.getByRole('button', { name: 'Continue', exact: true });
    await retry.click({ timeout: 3_000 });
    await page.waitForFunction('window.navigationAttempts === 2');
    await expect.poll(() => retry.isEnabled()).toBe(true);
    await retry.click();
    await completeNativeAuthentication();
    expect(await page.evaluate('window.navigationAttempts')).toBe(3);
    expect(await page.evaluate('window.ceremonies')).toEqual([mediation]);
    const session = await page.evaluate<{ data: { session: { id: string } } }>(
      'window.client.getSession()',
    );
    expect(session.data.session.id).toBe(initialSession.data.session.id);
  },
  20_000,
);

test.each(['generate-authenticate-options', 'verify-authentication'])(
  'reports explicit HTTP timeout at %s and allows a successful retry',
  async (endpoint) => {
    await enrollAndOpenLogin();
    await page.evaluate(
      `PublicKeyCredential.isConditionalMediationAvailable = async () => false`,
    );
    await page.clock.install();
    let captured = false;
    let first = true;
    let release: () => void = () => {};
    await page.route(`**/passkey/${endpoint}`, async (route) => {
      if (!first) return route.continue();
      first = false;
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.abort().catch(() => {});
    });
    await page.evaluate('window.mount()');
    const button = page.getByRole('button', { name: 'Sign in with a passkey' });
    await button.click();
    await vi.waitFor(() => expect(captured).toBe(true));
    await page.clock.fastForward(15_001);
    await expect.poll(() => button.isEnabled()).toBe(true);
    await page.clock.runFor(32);
    await page
      .getByText(/request timed out/i)
      .waitFor({ state: 'visible', timeout: 3_000 });
    expect(await page.evaluate('window.signedIn === true')).toBe(false);
    const session = await page.evaluate<{ data: unknown }>(
      'window.client.getSession()',
    );
    expect(session.data).toBeNull();
    release();
    await button.click();
    await completeNativeAuthentication();
  },
  20_000,
);

test('the HTTP timeout does not limit time spent in the native prompt or report disposal as a failure', async () => {
  await enrollAndOpenLogin(false);
  await page.evaluate(
    `PublicKeyCredential.isConditionalMediationAvailable = async () => false`,
  );
  await page.clock.install();
  await page.evaluate('window.mount()');
  const button = page.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();
  await page.waitForFunction('window.ceremonies.length === 1');
  await page.clock.fastForward(20_000);
  expect(await button.isEnabled()).toBe(false);
  expect(await page.getByText(/request timed out/i).count()).toBe(0);
  await page.evaluate('window.unmount()');
  await page.clock.runFor(32);
  expect(await page.getByText(/request timed out/i).count()).toBe(0);
  expect(await page.evaluate('window.signedIn === true')).toBe(false);
}, 20_000);

test('an older valid session can complete native passkey enrollment', async () => {
  await db.update(schema.session).set({
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000),
  });
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).toBeNull();
  await expect(db.select().from(schema.passkey)).resolves.toHaveLength(1);
});

test('focus restores autofill after a transient options server failure', async () => {
  await enrollAndOpenLogin();
  let requests = 0;
  await page.route('**/passkey/generate-authenticate-options', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE' }),
        })
      : route.continue();
  });
  const failed = page.waitForResponse((response) => response.status() === 503);
  await page.evaluate('window.mount()');
  await (await failed).finished();
  await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  expect(requests).toBe(1);
  await page.evaluate(`window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));`);
  await completeNativeAuthentication();
  expect(requests).toBe(2);
  expect(await page.evaluate('window.ceremonies')).toEqual(['conditional']);
}, 20_000);

test('network restoration resumes autofill after an offline options request', async () => {
  await enrollAndOpenLogin();
  await context.setOffline(true);
  const failed = page.waitForEvent('requestfailed', {
    predicate: (request) =>
      request.url().endsWith('/passkey/generate-authenticate-options'),
  });
  await page.evaluate('window.mount()');
  await failed;
  await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  await context.setOffline(false);
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual(['conditional']);
}, 20_000);

test('autofill recovery cannot interrupt explicit sign-in after an options failure', async () => {
  await enrollAndOpenLogin();
  let requests = 0;
  await page.route('**/passkey/generate-authenticate-options', (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE' }),
        })
      : route.continue();
  });
  let captured = false;
  let release: () => void = () => {};
  await page.route('**/passkey/verify-authentication', async (route) => {
    captured = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  const failed = page.waitForResponse((response) => response.status() === 503);
  await page.evaluate('window.mount()');
  await (await failed).finished();
  await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await vi.waitFor(() => expect(captured).toBe(true));
  await page.evaluate(`window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));`);
  await page.evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
  expect(requests).toBe(2);
  expect(await page.evaluate('window.ceremonies')).toEqual(['explicit']);
  release();
  await completeNativeAuthentication();
}, 20_000);

test('focus restores autofill after the options HTTP timeout', async () => {
  await enrollAndOpenLogin();
  await page.clock.install();
  let captured = false;
  let release: () => void = () => {};
  let requests = 0;
  await page.route(
    '**/passkey/generate-authenticate-options',
    async (route) => {
      requests++;
      if (requests !== 1) return route.continue();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.abort().catch(() => {});
    },
  );
  let failed = false;
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/passkey/generate-authenticate-options'))
      failed = true;
  });
  await page.evaluate('window.mount()');
  await vi.waitFor(() => expect(captured).toBe(true));
  await page.clock.fastForward(15_001);
  await vi.waitFor(() => expect(failed).toBe(true));
  release();
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await completeNativeAuthentication();
  expect(requests).toBe(2);
  expect(await page.evaluate('window.ceremonies')).toEqual(['conditional']);
}, 20_000);

test.each([403, 'unmount'] as const)(
  'does not restart autofill after permanent rejection or disposal: %s',
  async (failure) => {
    await enrollAndOpenLogin();
    let requests = 0;
    await page.route('**/passkey/generate-authenticate-options', (route) => {
      requests++;
      return route.fulfill({
        status: failure === 'unmount' ? 503 : failure,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'REJECTED' }),
      });
    });
    const failed = page.waitForResponse((response) => response.status() >= 400);
    await page.evaluate('window.mount()');
    await (await failed).finished();
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(resolve))',
    );
    if (failure === 'unmount') await page.evaluate('window.unmount()');
    await page.evaluate(`window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));`);
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(resolve))',
    );
    expect(requests).toBe(1);
    expect(await page.evaluate('window.ceremonies')).toEqual([]);
  },
  20_000,
);

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
  const registration = await page.evaluate<ApiResult>('window.register()');
  expect(registration.error).not.toBeNull();
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  });
  expect(credentials).toHaveLength(0);
  await expect(db.select().from(schema.passkey)).resolves.toEqual([]);
}, 15_000);

test('a late autofill options response cannot abort explicit sign-in', async () => {
  await enrollAndOpenLogin();
  let release: () => void = () => {};
  let first = true;
  let captured = false;
  await page.route(
    '**/passkey/generate-authenticate-options',
    async (route) => {
      if (!first) return route.continue();
      first = false;
      const response = await route.fetch();
      captured = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ response }).catch(() => {});
    },
  );
  await page.evaluate('window.mount()');
  await vi.waitFor(() => expect(captured).toBe(true));
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.waitForFunction('window.ceremonies.includes("explicit")');
  release();
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual(['explicit']);
}, 20_000);

test('renews pending autofill before challenge expiry and still signs in', async () => {
  await enrollAndOpenLogin(false);
  await page.clock.install();
  await page.evaluate('window.mount()');
  await page.waitForFunction('window.ceremonies.length === 1');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId,
    enabled: true,
  });
  await db.delete(schema.verification);
  await page.clock.fastForward(241_000);
  await page.waitForFunction('window.ceremonies.length === 2');
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual([
    'conditional',
    'conditional',
  ]);
}, 20_000);

test('explicit sign-in takes over an already pending native autofill ceremony', async () => {
  await enrollAndOpenLogin(false);
  await page.evaluate('window.mount()');
  await page.waitForFunction('window.ceremonies.length === 1');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId,
    enabled: true,
  });
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual([
    'conditional',
    'explicit',
  ]);
}, 20_000);

test('refreshes an expired native request on returning to a sleeping tab', async () => {
  await enrollAndOpenLogin(false);
  await page.clock.install();
  await page.evaluate('window.mount()');
  await page.waitForFunction('window.ceremonies.length === 1');
  const now = await page.evaluate<number>('Date.now()');
  await page.clock.setSystemTime(now + 301_000);
  await db.delete(schema.verification);
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
    authenticatorId,
    enabled: true,
  });
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual([
    'conditional',
    'conditional',
  ]);
}, 20_000);

test('focus restoration does not replace a challenge being verified', async () => {
  await enrollAndOpenLogin();
  await page.clock.install();
  let release: () => void = () => {};
  let captured = false;
  await page.route('**/passkey/verify-authentication', async (route) => {
    captured = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await page.evaluate('window.mount()');
  await vi.waitFor(() => expect(captured).toBe(true), { timeout: 5_000 });
  const now = await page.evaluate<number>('Date.now()');
  await page.clock.setSystemTime(now + 241_000);
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  release();
  await completeNativeAuthentication();
  expect(await page.evaluate('window.ceremonies')).toEqual(['conditional']);
}, 20_000);

test('recovers autofill after the server loses an expired challenge', async () => {
  await enrollAndOpenLogin();
  let first = true;
  await page.route('**/passkey/verify-authentication', async (route) => {
    if (first) {
      first = false;
      // Reproduce expiry/cleanup after native authentication, before verification.
      await db.delete(schema.verification);
    }
    await route.continue();
  });
  let failed = false;
  page.on('response', async (response) => {
    if (!response.url().endsWith('/passkey/verify-authentication')) return;
    const body = await response.json();
    if (body.code === 'CHALLENGE_NOT_FOUND') {
      failed = true;
    }
  });
  await page.evaluate('window.mount()');
  await vi.waitFor(() => expect(failed).toBe(true), { timeout: 5_000 });
  await page.waitForFunction('window.ceremonies.length === 2');
  await completeNativeAuthentication();
}, 20_000);
