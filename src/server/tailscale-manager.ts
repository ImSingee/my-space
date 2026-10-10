import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  appServiceSnapshotSchema,
  type AppServiceAdvertisement,
} from '../app-tailscale';
import { constants } from 'node:fs';
import { access, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { WORKSPACE_ROOT } from '../agent/paths';
import { resolveTailscalePort } from '../platform-port';
import {
  tailscaleConfigSchema,
  tailscaleLoginUrlSchema,
  tailscaleOriginSchema,
  type TailscaleConfig,
  type TailscaleStatus,
} from '../tailscale';

const helperStatusSchema = z.object({
  tags: z.array(z.string().max(128)).max(100).default([]),
  nodeId: z.string().max(128).default(''),
  suffix: z.string().max(253).default(''),
  services: z.array(appServiceSnapshotSchema).max(1000).default([]),
  state: z.enum([
    'starting',
    'needs-login',
    'needs-approval',
    'connected',
    'error',
  ]),
  loginUrl: z.string().max(2048),
  origin: z.string().max(253),
  message: z.string().max(1000),
});

type Dependencies = {
  load: () => Promise<TailscaleConfig>;
  save: (config: TailscaleConfig) => Promise<void>;
  binary: string;
  stateDir: string;
  port: number;
  loadServices?: () => Promise<AppServiceAdvertisement[]>;
};

/** One serialized lifecycle owns both the node and its trusted HTTPS origin. */
export class TailscaleManager {
  private ingressToken = randomBytes(32).toString('base64url');
  private advertisements: AppServiceAdvertisement[] = [];
  private serviceTimer: ReturnType<typeof setInterval> | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStatus = 0;
  private status: TailscaleStatus = {
    enabled: false,
    hostname: 'hatch',
    available: false,
    state: 'disconnected',
    loginUrl: null,
    origin: null,
    message: null,
  };

  constructor(private readonly deps: Dependencies) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  async initialize() {
    this.initialized ??= this.serialize(async () => {
      const config = tailscaleConfigSchema.parse(await this.deps.load());
      this.status = { ...this.status, ...config };
      if (config.enabled) await this.start();
      if (this.deps.loadServices && !this.serviceTimer) {
        this.serviceTimer = setInterval(() => {
          void this.refreshServices().catch(() => {
            // Fail closed if persisted bindings can no longer be reconciled.
            this.advertisements = [];
            this.status.services = [];
            this.sendServices();
          });
        }, 2000);
        this.serviceTimer.unref();
      }
    }).catch((error: unknown) => {
      this.initialized = null;
      throw error;
    });
    await this.initialized;
  }

  private async isAvailable() {
    try {
      await access(this.deps.binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private clear(
    state: TailscaleStatus['state'],
    message: string | null = null,
  ) {
    this.status = {
      ...this.status,
      state,
      origin: null,
      loginUrl: null,
      message,
      services: [],
    };
  }

  snapshot(): TailscaleStatus {
    if (
      this.child &&
      this.lastStatus &&
      Date.now() - this.lastStatus > 40_000
    ) {
      this.clear(
        'error',
        'The connection stopped responding. Reconnect to try again.',
      );
    }
    return { ...this.status };
  }

  trustedOrigin(): string | null {
    const status = this.snapshot();
    return status.enabled && status.state === 'connected'
      ? status.origin
      : null;
  }

  serviceSnapshot(appId: string) {
    const global = this.snapshot();
    if (!global.enabled || global.state !== 'connected') return null;
    const desired = this.advertisements.find((s) => s.appId === appId);
    return (
      global.services?.find(
        (s) =>
          s.appId === appId &&
          s.serviceName === desired?.serviceName &&
          s.revision === desired?.revision,
      ) ?? null
    );
  }

  verifyIngress(token: string | null): boolean {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !this.child)
      return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.ingressToken));
  }

  private sendServices() {
    if (this.child?.stdin.writable) {
      this.child.stdin.write(
        JSON.stringify({
          version: 1,
          token: this.ingressToken,
          services: this.advertisements,
        }) + '\n',
      );
    }
  }

  async refreshServices() {
    return this.serialize(() => this.reconcileServices());
  }

  /** Serialize App identity writes with node renames and connection changes. */
  async mutateServices<T>(write: (hostname: string) => Promise<T>): Promise<T> {
    await this.initialize();
    return this.serialize(async () => {
      const result = await write(this.status.hostname);
      await this.reconcileServices();
      return result;
    });
  }

  private async reconcileServices() {
    const next = (await this.deps.loadServices?.()) ?? [];
    if (JSON.stringify(next) === JSON.stringify(this.advertisements)) return;
    this.advertisements = next;
    this.status.services = this.status.services?.filter((s) =>
      next.some(
        (n) =>
          n.appId === s.appId &&
          n.serviceName === s.serviceName &&
          n.revision === s.revision,
      ),
    );
    this.sendServices();
  }

  async getStatus() {
    await this.initialize();
    this.status.available = await this.isAvailable();
    return this.snapshot();
  }

  async configure(input: TailscaleConfig) {
    const config = tailscaleConfigSchema.parse(input);
    await this.initialize();
    return this.serialize(async () => {
      if (config.enabled && !(await this.isAvailable())) {
        throw new Error(
          'Tailscale is not included in this installation. See the setup instructions.',
        );
      }
      const services = (await this.deps.loadServices?.()) ?? [];
      if (
        config.enabled &&
        services.some((service) => service.serviceName === config.hostname)
      )
        throw new Error('The node name is already used by an App Service.');
      // Persist first: a restart after disconnect must never re-enable ingress.
      await this.deps.save(config);
      this.status = { ...this.status, ...config };
      await this.stop();
      if (config.enabled) await this.start();
      return this.snapshot();
    });
  }

  private async start() {
    this.status.available = await this.isAvailable();
    if (!this.status.available) {
      this.clear('error', 'Tailscale is not included in this installation.');
      return;
    }
    await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.deps.stateDir, 0o700);
    this.advertisements = (await this.deps.loadServices?.()) ?? [];
    this.clear('starting');
    this.lastStatus = Date.now();
    // Do not pass platform secrets, database URLs, or ambient TS_AUTHKEY to
    // the helper. Enrollment happens explicitly through its login URL.
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH',
      'HOME',
      'TMPDIR',
      'SYSTEMROOT',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(
      this.deps.binary,
      [
        '--hostname',
        this.status.hostname,
        '--state-dir',
        this.deps.stateDir,
        '--port',
        String(this.deps.port),
      ],
      { env, stdio: 'pipe' },
    );
    this.child = child;
    this.ingressToken = randomBytes(32).toString('base64url');
    child.stdin.on('error', () => {
      if (this.child === child)
        this.clear('error', 'The Tailscale control channel stopped.');
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      try {
        const next = helperStatusSchema.parse(JSON.parse(line));
        const origin =
          next.state === 'connected'
            ? tailscaleOriginSchema.parse(next.origin)
            : null;
        const loginUrl =
          next.state === 'needs-login' && next.loginUrl
            ? tailscaleLoginUrlSchema.parse(next.loginUrl)
            : null;
        this.lastStatus = Date.now();
        this.status = {
          ...this.status,
          state: next.state,
          origin,
          loginUrl,
          message: next.message || null,
          tags: next.tags,
          nodeId: next.nodeId,
          suffix: next.suffix,
          services: next.services.map((s) => {
            if (s.origin) {
              tailscaleOriginSchema.parse(s.origin);
              if (s.origin !== `https://${s.serviceName}.${next.suffix}`)
                throw new Error('Unexpected Service origin');
            }
            if (s.state === 'ready' && !s.origin)
              throw new Error('Missing Service origin');
            return s;
          }),
        };
      } catch {
        this.clear(
          'error',
          'Received an invalid connection status. Reconnect to try again.',
        );
      }
    });
    // Drain diagnostics without publishing sensitive tsnet logs or auth URLs.
    child.stderr.resume();
    child.on('error', () => {
      if (this.child === child)
        this.clear('error', 'Unable to start the Tailscale connection.');
    });
    child.on('close', () => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      this.clear(
        'error',
        'The Tailscale connection stopped. Reconnect to try again.',
      );
    });
    this.sendServices();
  }

  private async stop() {
    const child = this.child;
    this.clear('disconnected');
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }

  /** Preserve the enabled preference while closing all listeners at shutdown. */
  async shutdown() {
    if (this.serviceTimer) clearInterval(this.serviceTimer);
    this.serviceTimer = null;
    await this.serialize(() => this.stop());
  }
}

declare global {
  var hatchTailscaleManager: TailscaleManager | undefined;
}

export function getTailscaleManager() {
  const port = resolveTailscalePort();
  globalThis.hatchTailscaleManager ??= new TailscaleManager({
    binary:
      process.env.HATCH_TAILSCALE_BINARY ?? path.resolve('bin/hatch-tailscale'),
    stateDir: path.join(WORKSPACE_ROOT, '.tailscale'),
    port,
    loadServices: async () => {
      const { advertisedAppServices } =
        await import('./apps/tailscale-services');
      return advertisedAppServices();
    },
    load: async () => {
      const { getPlatformConfig } = await import('./platform-config');
      return getPlatformConfig('network.tailscale');
    },
    save: async (config) => {
      const { setPlatformConfig } = await import('./platform-config');
      await setPlatformConfig('network.tailscale', config);
    },
  });
  return globalThis.hatchTailscaleManager;
}
