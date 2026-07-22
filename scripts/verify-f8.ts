/**
 * F8 verification: app cron invokes a declared proto RPC method (not an
 * arbitrary URL), and the platform signs the call (HMAC) so the backend can
 * verify it came from the platform. Covers:
 *   1. secrets: hatchSignature determinism + verifyHatchSignature (valid / bad
 *      sig / stale ts / wrong secret).
 *   2. manifest: cron job requires exactly one of method|path.
 *   3. e2e: deploy a Connect app whose RunCron RPC verifies the signature;
 *      runCronJobNow succeeds (signed) and increments; an UNSIGNED/forged direct
 *      call is rejected; signingSecret is generated.
 *   4. deploy validation: a cron `method` not in the proto fails the deploy.
 *
 * Run: direnv exec . env HATCH_DATA_DIR=../my-space-data pnpm tsx scripts/verify-f8.ts
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { appBuildDir, appRepoDir, appSrcDir } from '../src/agent/paths';
import { writeScaffoldFiles } from '../src/agent/scaffold-files';
import { db, schema } from '../src/db';
import { deployApp } from '../src/server/apps/deploy';
import { ensureAppRepo } from '../src/server/apps/git';
import { parseSourceManifest } from '../src/server/apps/manifest';
import { callAppBackend, stopApp } from '../src/server/apps/runtime';
import { runCronJobNow } from '../src/server/apps/scheduler';
import { createApp } from '../src/server/apps/scaffold';
import { hatchSignature, verifyHatchSignature } from '../src/server/secrets';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`, detail !== undefined ? detail : '');
  }
}

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

const PROTO = `syntax = "proto3";
package app.v1;
message GetCountRequest {}
message IncrementRequest { int32 amount = 1; }
message CountReply { int32 count = 1; }
service CounterService {
  rpc GetCount(GetCountRequest) returns (CountReply);
  rpc Increment(IncrementRequest) returns (CountReply);
  rpc RunCron(GetCountRequest) returns (CountReply);
  // Server-streaming method: used to assert cron rejects non-unary targets.
  rpc StreamCount(GetCountRequest) returns (stream CountReply);
}
`;

const BACKEND = `import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import { CounterService } from '../gen/service_pb.ts';

let count = 0;

function assertFromPlatform(ctx: HandlerContext) {
  const h = ctx.requestHeader;
  const secret = Deno.env.get('HATCH_SIGNING_SECRET');
  const ts = h.get('x-hatch-timestamp');
  const job = h.get('x-hatch-cron');
  const sig = h.get('x-hatch-signature');
  if (!secret || !ts || !job || !sig) {
    throw new ConnectError('unsigned', Code.PermissionDenied);
  }
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) {
    throw new ConnectError('stale', Code.PermissionDenied);
  }
  const want =
    'sha256=' +
    createHmac('sha256', secret).update(\`\${ts}.\${job}\`).digest('hex');
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ConnectError('bad signature', Code.PermissionDenied);
  }
}

function routes(router: ConnectRouter) {
  router.service(CounterService, {
    async getCount() {
      return { count };
    },
    async increment(req) {
      count += req.amount || 1;
      return { count };
    },
    async runCron(_req, ctx) {
      assertFromPlatform(ctx);
      count += 1;
      return { count };
    },
    async *streamCount() {
      yield { count };
    },
  });
}

const port = Number(Deno.env.get('PORT') ?? '8080');
http.createServer(connectNodeAdapter({ routes })).listen(port, () => {
  console.log(\`backend on :\${port}\`);
});
`;

function manifest(
  id: string,
  cronMethod: string,
  opts: { withBackendEntry?: boolean } = {},
): string {
  const withBackendEntry = opts.withBackendEntry ?? true;
  return JSON.stringify(
    {
      id,
      name: 'F8 Cron RPC',
      version: 1,
      capabilities: {
        database: false,
        frontend: false,
        widgets: false,
        backend: true,
        cron: true,
        webhook: false,
      },
      backendMode: 'serverless',
      rpc: { proto: 'proto/service.proto', service: 'app.v1.CounterService' },
      // Omitted on purpose for the "backend capability but no entry" case.
      ...(withBackendEntry ? { backend: { entry: 'backend/main.ts' } } : {}),
      cron: [{ name: 'beat', schedule: '* * * * *', method: cronMethod }],
    },
    null,
    2,
  );
}

/**
 * Parse a Connect unary JSON reply { count }. proto3 JSON omits zero-valued
 * fields, so a `{}` body means count === 0 (not "missing"); only a non-JSON
 * body (e.g. a transport error) yields null.
 */
function parseCount(body: string): number | null {
  try {
    const obj = JSON.parse(body) as { count?: number };
    return typeof obj.count === 'number' ? obj.count : 0;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // -- 1) secrets --------------------------------------------------------------
  console.log('[1] secrets: hatchSignature / verifyHatchSignature');
  const ts = String(Date.now());
  const sig = hatchSignature('s3cr3t', ts, 'beat');
  check(
    'signature is deterministic',
    sig === hatchSignature('s3cr3t', ts, 'beat'),
  );
  check('signature is prefixed sha256=', sig.startsWith('sha256='), sig);
  check(
    'verify accepts a fresh valid signature',
    verifyHatchSignature({
      secret: 's3cr3t',
      timestamp: ts,
      payload: 'beat',
      signature: sig,
    }),
  );
  check(
    'verify rejects a wrong secret',
    !verifyHatchSignature({
      secret: 'other',
      timestamp: ts,
      payload: 'beat',
      signature: sig,
    }),
  );
  check(
    'verify rejects a tampered payload',
    !verifyHatchSignature({
      secret: 's3cr3t',
      timestamp: ts,
      payload: 'evil',
      signature: sig,
    }),
  );
  check(
    'verify rejects a stale timestamp',
    !verifyHatchSignature({
      secret: 's3cr3t',
      timestamp: String(Date.now() - 10 * 60_000),
      payload: 'beat',
      signature: hatchSignature(
        's3cr3t',
        String(Date.now() - 10 * 60_000),
        'beat',
      ),
    }),
  );
  check(
    'verify rejects missing signature',
    !verifyHatchSignature({
      secret: 's3cr3t',
      timestamp: ts,
      payload: 'beat',
      signature: null,
    }),
  );

  // -- 2) manifest cron schema -------------------------------------------------
  console.log('[2] manifest: cron job requires exactly one of method|path');
  const base = {
    id: 'tmp-f8',
    name: 't',
    capabilities: { backend: true, cron: true },
    backend: { entry: 'backend/main.ts' },
  };
  const methodOk = (() => {
    try {
      parseSourceManifest({
        ...base,
        cron: [{ name: 'a', schedule: '* * * * *', method: 'RunCron' }],
      });
      return true;
    } catch {
      return false;
    }
  })();
  check('method-only job parses', methodOk);
  const pathOk = (() => {
    try {
      parseSourceManifest({
        ...base,
        cron: [{ name: 'a', schedule: '* * * * *', path: '/__cron/x' }],
      });
      return true;
    } catch {
      return false;
    }
  })();
  check('path-only job parses (legacy)', pathOk);
  const bothRejected = (() => {
    try {
      parseSourceManifest({
        ...base,
        cron: [{ name: 'a', schedule: '* * * * *', method: 'M', path: '/p' }],
      });
      return false;
    } catch {
      return true;
    }
  })();
  check('job with BOTH method and path rejected', bothRejected);
  const neitherRejected = (() => {
    try {
      parseSourceManifest({
        ...base,
        cron: [{ name: 'a', schedule: '* * * * *' }],
      });
      return false;
    } catch {
      return true;
    }
  })();
  check('job with NEITHER method nor path rejected', neitherRejected);

  // -- 3 & 4) deploy a real cron-RPC app --------------------------------------
  console.log('[3+4] deploy Connect app with signed cron RPC method');
  const slug = `f8-cron-${Date.now().toString(36)}`;
  const { id, files } = await createApp({
    slug,
    name: 'F8 Cron RPC',
    pin: false,
  });
  console.log(`  created app id=${id} slug=${slug}`);

  let deployed = false;
  try {
    const repoPath = await ensureAppRepo(id);
    const srcDir = appSrcDir(id);
    // createApp now returns the scaffold instead of writing it; materialize
    // it here like the Agent Runner would.
    await writeScaffoldFiles(srcDir, files);
    // Reduce the scaffold to a backend-only Connect app with a cron RPC method.
    await fs.rm(path.join(srcDir, 'app'), { recursive: true, force: true });
    await fs.rm(path.join(srcDir, 'widgets'), { recursive: true, force: true });
    await fs.writeFile(path.join(srcDir, 'proto', 'service.proto'), PROTO);
    await fs.writeFile(path.join(srcDir, 'backend', 'main.ts'), BACKEND);
    await fs.writeFile(
      path.join(srcDir, 'manifest.json'),
      manifest(id, 'RunCron'),
    );

    git(['init', '--initial-branch', 'master'], srcDir);
    git(['remote', 'add', 'origin', repoPath], srcDir);
    git(['config', 'user.email', 'verify@hatch.local'], srcDir);
    git(['config', 'user.name', 'F8 Verify'], srcDir);
    git(['add', '-A'], srcDir);
    git(['commit', '-m', 'f8 verify'], srcDir);

    await deployApp(id, { sourceDir: srcDir, message: 'f8 verify deploy' });
    deployed = true;

    const row = await db.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: { signingSecret: true },
    });
    check(
      'deploy generated a per-app signingSecret',
      Boolean(row?.signingSecret),
    );

    // Baseline counter.
    const c0 = parseCount(
      (
        await callAppBackend(id, '/app.v1.CounterService/GetCount', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).body,
    );

    // Signed cron call via the scheduler (the platform path) — must succeed.
    const run = await runCronJobNow(id, 'beat');
    check('signed cron RPC call returns 200', run.status === 200, run);
    check(
      'cron RPC reply is a CountReply',
      parseCount(run.body) !== null,
      run.body,
    );

    const c1 = parseCount(
      (
        await callAppBackend(id, '/app.v1.CounterService/GetCount', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).body,
    );
    check(
      'signed cron incremented the counter by 1',
      c0 !== null && c1 === c0 + 1,
      { c0, c1 },
    );

    // UNSIGNED direct call to the same method — backend must reject it.
    const unsigned = await callAppBackend(
      id,
      '/app.v1.CounterService/RunCron',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    check(
      'unsigned RunCron is rejected (non-200)',
      unsigned.status !== 200,
      unsigned,
    );

    // FORGED signature — backend must reject it.
    const forged = await callAppBackend(id, '/app.v1.CounterService/RunCron', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hatch-cron': 'beat',
        'x-hatch-timestamp': String(Date.now()),
        'x-hatch-signature': 'sha256=deadbeef',
      },
      body: '{}',
    });
    check(
      'forged-signature RunCron is rejected (non-200)',
      forged.status !== 200,
      forged,
    );

    const c2 = parseCount(
      (
        await callAppBackend(id, '/app.v1.CounterService/GetCount', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).body,
    );
    check(
      'rejected calls did NOT increment the counter',
      c1 !== null && c2 === c1,
      { c1, c2 },
    );

    // 4) Deploy validation. Each redeploy patches only the manifest and expects
    // deployApp to throw before recording a usable deployment.
    const expectRejected = async (
      label: string,
      manifestJson: string,
      needle: string,
    ): Promise<void> => {
      await fs.writeFile(path.join(srcDir, 'manifest.json'), manifestJson);
      git(['add', '-A'], srcDir);
      git(['commit', '-m', label], srcDir);
      let msg = '';
      try {
        await deployApp(id, { sourceDir: srcDir, message: label });
      } catch (e) {
        msg = (e as Error).message;
      }
      check(`deploy rejects: ${label}`, msg !== '', msg || '(no throw)');
      check(`  …message mentions "${needle}"`, msg.includes(needle), msg);
    };

    // a) method not defined in the proto service.
    await expectRejected(
      'cron method not in proto',
      manifest(id, 'NopeMethod'),
      'NopeMethod',
    );
    // b) method is a streaming RPC (cron only supports unary).
    await expectRejected(
      'cron method is streaming',
      manifest(id, 'StreamCount'),
      'streaming',
    );
    // c) backend capability + rpc + cron method but no backend.entry staged.
    await expectRejected(
      'cron method without a staged backend entry',
      manifest(id, 'RunCron', { withBackendEntry: false }),
      'backend.entry',
    );
  } finally {
    stopApp(id);
    await db
      .delete(schema.apps)
      .where(eq(schema.apps.id, id))
      .catch(() => {});
    await fs
      .rm(appSrcDir(id), { recursive: true, force: true })
      .catch(() => {});
    await fs
      .rm(appBuildDir(id), { recursive: true, force: true })
      .catch(() => {});
    await fs
      .rm(appRepoDir(id), { recursive: true, force: true })
      .catch(() => {});
    if (!deployed) console.log('  (app was not deployed; cleaned up)');
  }

  console.log(`\nF8 verify: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nF8 VERIFY CRASHED:', e);
  process.exit(1);
});
