/**
 * F9 verification: inbound webhooks support two platform-side auth modes.
 *
 *   - `platform` (default): the platform mints a per-app secret, verifies it on
 *     the public `/api/hooks/<id>` route, STRIPS it, and forwards an HMAC-signed
 *     request to the backend's `/__webhook` (secret never reaches the app).
 *   - `none`: unauthenticated passthrough — no secret, no signature; the raw
 *     request (including any `?secret=`) is forwarded untouched.
 *
 * Covers:
 *   1. manifest: webhook.auth defaults to 'platform', accepts 'none', rejects
 *      bogus values; normalizeManifest carries the auth mode.
 *   2. deploy gating: platform mode mints webhookSecret + signingSecret; none
 *      mode clears webhookSecret (keeps signingSecret); webhook w/o backend is
 *      rejected.
 *   3. e2e platform: a correct secret → 200, forwarded WITHOUT the secret and
 *      WITH a valid HMAC; a wrong secret → 403; an x-hatch-secret header lets a
 *      `?secret=` app param survive; a caller-forged signature header is
 *      stripped.
 *   4. e2e none: any/no secret → 200 passthrough, NO signature header reaches
 *      the backend, and `?secret=` is preserved.
 *
 * Run: direnv exec . env HATCH_DATA_DIR=../my-space-data pnpm tsx scripts/verify-f9.ts
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
import { rollbackApp } from '../src/server/apps/manage';
import {
  normalizeManifest,
  parseSourceManifest,
} from '../src/server/apps/manifest';
import { stopApp } from '../src/server/apps/runtime';
import { createApp } from '../src/server/apps/scaffold';
import { Route, handle } from '../src/routes/api/hooks/$appId/$';

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

// A Connect-free plain-HTTP backend. Its `/__webhook` handler echoes back what
// it actually received so the test can assert the platform's forwarding
// contract: whether a `?secret=` survived, whether a signature was present, and
// whether that signature validates against HATCH_SIGNING_SECRET over
// `<timestamp>.<rawBody>`.
const BACKEND = `import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

const port = Number(Deno.env.get('PORT') ?? '8080');

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBuf = Buffer.concat(chunks);
    const raw = rawBuf.toString('utf8');
    const url = new URL(req.url ?? '/', 'http://localhost');

    const secret = Deno.env.get('HATCH_SIGNING_SECRET');
    const ts = req.headers['x-hatch-timestamp'];
    const sig = req.headers['x-hatch-signature'];
    let sigValid = false;
    if (secret && typeof ts === 'string' && typeof sig === 'string') {
      // Verify over the EXACT raw bytes (Buffer), matching the platform — a
      // UTF-8 decode would corrupt binary payloads and break verification.
      const want =
        'sha256=' +
        createHmac('sha256', secret)
          .update(Buffer.concat([Buffer.from(\`\${ts}.\`), rawBuf]))
          .digest('hex');
      const a = Buffer.from(want);
      const b = Buffer.from(sig);
      sigValid = a.length === b.length && timingSafeEqual(a, b);
    }

    const out = JSON.stringify({
      path: url.pathname,
      secretParam: url.searchParams.get('secret'),
      hasSig: Boolean(sig),
      sigValid,
      body: raw,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  })
  .listen(port, () => {
    console.log(\`backend on :\${port}\`);
  });
`;

function manifest(
  id: string,
  opts: { auth?: 'platform' | 'none'; backend?: boolean } = {},
): string {
  const auth = opts.auth ?? 'platform';
  const backend = opts.backend ?? true;
  return JSON.stringify(
    {
      id,
      name: 'F9 Webhook',
      version: 1,
      capabilities: {
        database: false,
        frontend: false,
        widgets: false,
        backend,
        cron: false,
        webhook: true,
        storage: false,
      },
      backendMode: 'serverless',
      ...(backend ? { backend: { entry: 'backend/main.ts' } } : {}),
      webhook: { auth },
    },
    null,
    2,
  );
}

type Echo = {
  path: string;
  secretParam: string | null;
  hasSig: boolean;
  sigValid: boolean;
  body: string;
};

async function call(
  id: string,
  query: string,
  init: RequestInit & { duplex?: 'half' },
): Promise<{ status: number; echo: Echo | null; text: string }> {
  const req = new Request(`http://localhost/api/hooks/${id}/event${query}`, {
    method: 'POST',
    ...init,
  });
  const res = await handle({ request: req });
  const text = await res.text();
  let echo: Echo | null = null;
  try {
    echo = JSON.parse(text) as Echo;
  } catch {
    echo = null;
  }
  return { status: res.status, echo, text };
}

async function main(): Promise<void> {
  // -- 1) manifest schema ------------------------------------------------------
  console.log('[1] manifest: webhook auth mode parsing + normalization');
  const baseCaps = {
    id: 'tmp-f9',
    name: 't',
    capabilities: { backend: true, webhook: true },
    backend: { entry: 'backend/main.ts' },
  };
  const defaultAuth = parseSourceManifest({ ...baseCaps }).webhook?.auth;
  check(
    'webhook block omitted → auth is undefined at source (defaults later)',
    defaultAuth === undefined,
    defaultAuth,
  );
  const emptyWebhook = parseSourceManifest({ ...baseCaps, webhook: {} }).webhook
    ?.auth;
  check(
    'webhook: {} → auth defaults to "platform"',
    emptyWebhook === 'platform',
    emptyWebhook,
  );
  const noneAuth = parseSourceManifest({
    ...baseCaps,
    webhook: { auth: 'none' },
  }).webhook?.auth;
  check('webhook: { auth: "none" } parses', noneAuth === 'none', noneAuth);
  const bogusRejected = (() => {
    try {
      parseSourceManifest({ ...baseCaps, webhook: { auth: 'bogus' } });
      return false;
    } catch {
      return true;
    }
  })();
  check('webhook: { auth: "bogus" } rejected', bogusRejected);

  // normalizeManifest must surface the auth mode (default + explicit).
  const normDefault = normalizeManifest(parseSourceManifest({ ...baseCaps }));
  check(
    'normalized webhook.auth defaults to "platform"',
    normDefault.webhook?.auth === 'platform',
    normDefault.webhook,
  );
  const normNone = normalizeManifest(
    parseSourceManifest({ ...baseCaps, webhook: { auth: 'none' } }),
  );
  check(
    'normalized webhook.auth carries "none"',
    normNone.webhook?.auth === 'none',
    normNone.webhook,
  );

  // -- 1b) route registers every webhook verb (not just GET/POST/PUT/DELETE) ---
  // Tests the registration directly: if a verb is missing here, TanStack Start
  // never routes it to `handle`, so the documented passthrough would break.
  console.log('[1b] route registers all webhook HTTP verbs');
  const handlerKeys = Object.keys(
    (Route.options as { server: { handlers: Record<string, unknown> } }).server
      .handlers,
  );
  for (const verb of [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
  ]) {
    check(`route handles ${verb}`, handlerKeys.includes(verb), handlerKeys);
  }

  // -- 2,3,4) deploy a real webhook app and drive the public route ------------
  console.log('[2+3+4] deploy webhook app; drive /api/hooks/<id> route');
  const slug = `f9-hook-${Date.now().toString(36)}`;
  const { id, files } = await createApp({
    slug,
    name: 'F9 Webhook',
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
    // Reduce the scaffold to a backend-only plain-HTTP app (no proto/rpc).
    await fs.rm(path.join(srcDir, 'app'), { recursive: true, force: true });
    await fs.rm(path.join(srcDir, 'widgets'), { recursive: true, force: true });
    await fs.rm(path.join(srcDir, 'proto'), { recursive: true, force: true });
    await fs.writeFile(path.join(srcDir, 'backend', 'main.ts'), BACKEND);
    await fs.writeFile(
      path.join(srcDir, 'manifest.json'),
      manifest(id, { auth: 'platform' }),
    );

    git(['init', '--initial-branch', 'master'], srcDir);
    git(['remote', 'add', 'origin', repoPath], srcDir);
    git(['config', 'user.email', 'verify@hatch.local'], srcDir);
    git(['config', 'user.name', 'F9 Verify'], srcDir);
    git(['add', '-A'], srcDir);
    git(['commit', '-m', 'f9 verify'], srcDir);

    // -- platform mode deploy --
    await deployApp(id, { sourceDir: srcDir, message: 'f9 platform deploy' });
    deployed = true;

    const rowPlatform = await db.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: {
        webhookSecret: true,
        signingSecret: true,
        currentDeploymentId: true,
      },
    });
    const secret = rowPlatform?.webhookSecret ?? '';
    const platformDeploymentId = rowPlatform?.currentDeploymentId ?? '';
    check(
      'platform deploy minted a webhookSecret',
      Boolean(rowPlatform?.webhookSecret),
    );
    check(
      'platform deploy minted a signingSecret',
      Boolean(rowPlatform?.signingSecret),
    );

    // (3a) correct secret via ?secret= → 200, secret stripped, HMAC valid.
    const okSecret = await call(id, `?secret=${secret}`, {
      headers: { 'content-type': 'application/json' },
      body: '{"hello":"world"}',
    });
    check(
      'platform: correct ?secret= → 200',
      okSecret.status === 200,
      okSecret,
    );
    check(
      'platform: forwarded to /__webhook/event',
      okSecret.echo?.path === '/__webhook/event',
      okSecret.echo?.path,
    );
    check(
      'platform: secret was STRIPPED before forward',
      okSecret.echo?.secretParam === null,
      okSecret.echo?.secretParam,
    );
    check(
      'platform: forwarded request carries a VALID HMAC signature',
      okSecret.echo?.hasSig === true && okSecret.echo?.sigValid === true,
      okSecret.echo,
    );
    check(
      'platform: body forwarded intact',
      okSecret.echo?.body === '{"hello":"world"}',
      okSecret.echo?.body,
    );

    // (3b) wrong secret → 403, never reaches the backend.
    const badSecret = await call(id, `?secret=nope-${secret}`, {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check(
      'platform: wrong ?secret= → 403',
      badSecret.status === 403,
      badSecret,
    );

    // (3c) missing secret → 403.
    const noSecret = await call(id, '', {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check('platform: missing secret → 403', noSecret.status === 403, noSecret);

    // (3d) secret via x-hatch-secret header → app's own ?secret= survives.
    const headerSecret = await call(id, '?secret=app-token', {
      headers: {
        'content-type': 'application/json',
        'x-hatch-secret': secret,
      },
      body: '{}',
    });
    check(
      'platform: x-hatch-secret header authenticates → 200',
      headerSecret.status === 200,
      headerSecret,
    );
    check(
      'platform: app ?secret= preserved when authed via header',
      headerSecret.echo?.secretParam === 'app-token',
      headerSecret.echo?.secretParam,
    );
    check(
      'platform: header-authed request still HMAC-signed',
      headerSecret.echo?.sigValid === true,
      headerSecret.echo,
    );

    // (3e) a caller-forged signature header must be stripped (recomputed).
    const forged = await call(id, `?secret=${secret}`, {
      headers: {
        'content-type': 'application/json',
        'x-hatch-signature': 'sha256=deadbeef',
        'x-hatch-timestamp': '1',
      },
      body: '{"x":1}',
    });
    check(
      'platform: caller-forged signature is replaced by a valid one',
      forged.status === 200 && forged.echo?.sigValid === true,
      forged.echo,
    );

    // (3f) binary / non-UTF-8 body: the platform must HMAC the RAW bytes, so a
    // backend verifying over the exact bytes still validates (a UTF-8 decode
    // would mangle 0xff/0xfe and break the signature).
    const binBody = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);
    const binary = await call(id, `?secret=${secret}`, {
      headers: { 'content-type': 'application/octet-stream' },
      body: binBody,
    });
    check(
      'platform: binary body forwards with a VALID raw-bytes HMAC',
      binary.status === 200 && binary.echo?.sigValid === true,
      binary.echo,
    );

    // (3g) oversize body must be rejected with 413 (signed path buffers to HMAC,
    // so it is capped at 1MB). A declared Content-Length over the cap fails fast.
    const tooBigDeclared = await call(id, `?secret=${secret}`, {
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(1024 * 1024 + 16),
    });
    check(
      'platform: oversize body (declared length) → 413',
      tooBigDeclared.status === 413,
      tooBigDeclared.status,
    );

    // (3h) the dangerous case: NO Content-Length (a ReadableStream body, like
    // chunked transfer). The proxy must abort mid-stream once the running total
    // exceeds the cap instead of buffering it all first.
    const unbounded = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700 * 1024));
        controller.enqueue(new Uint8Array(700 * 1024));
        controller.close();
      },
    });
    const tooBigStreamed = await call(id, `?secret=${secret}`, {
      headers: { 'content-type': 'application/octet-stream' },
      body: unbounded,
      duplex: 'half',
    });
    check(
      'platform: oversize streamed body (no Content-Length) → 413',
      tooBigStreamed.status === 413,
      tooBigStreamed.status,
    );

    // -- none mode redeploy --
    await fs.writeFile(
      path.join(srcDir, 'manifest.json'),
      manifest(id, { auth: 'none' }),
    );
    git(['add', '-A'], srcDir);
    git(['commit', '-m', 'f9 none mode'], srcDir);
    stopApp(id);
    await deployApp(id, { sourceDir: srcDir, message: 'f9 none deploy' });

    const rowNone = await db.query.apps.findFirst({
      where: (s, { eq: e }) => e(s.id, id),
      columns: { webhookSecret: true, signingSecret: true },
    });
    // The secret is RETAINED (not nulled) across a none-mode deploy so a later
    // rollback to a platform-auth deployment still has its reusable secret.
    check(
      'none deploy RETAINED the webhookSecret (rollback safety)',
      rowNone?.webhookSecret === secret && secret !== '',
      rowNone?.webhookSecret,
    );
    check(
      'none deploy kept the signingSecret (backend present)',
      Boolean(rowNone?.signingSecret),
    );

    // (4a) passthrough: any secret/no secret → 200, no signature, secret kept.
    const passthrough = await call(id, '?secret=whatever&foo=bar', {
      headers: {
        'content-type': 'application/json',
        // A forged signature header from the caller must still be stripped.
        'x-hatch-signature': 'sha256=deadbeef',
        'x-hatch-timestamp': '1',
      },
      body: '{"evt":"push"}',
    });
    check('none: request → 200', passthrough.status === 200, passthrough);
    check(
      'none: NO signature header reaches the backend',
      passthrough.echo?.hasSig === false,
      passthrough.echo,
    );
    check(
      'none: ?secret= preserved (passthrough)',
      passthrough.echo?.secretParam === 'whatever',
      passthrough.echo?.secretParam,
    );
    check(
      'none: body forwarded intact',
      passthrough.echo?.body === '{"evt":"push"}',
      passthrough.echo?.body,
    );

    // (4b) non-CRUD verbs (PATCH/HEAD/OPTIONS) must reach the backend too — the
    // route registers every verb TanStack Start supports, not just GET/POST/
    // PUT/DELETE. HEAD returns no body, so only assert the status there.
    const patch = await call(id, '', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"patched":true}',
    });
    check(
      'none: PATCH reaches the backend (200)',
      patch.status === 200 && patch.echo?.path === '/__webhook/event',
      { status: patch.status, path: patch.echo?.path },
    );
    const options = await call(id, '', { method: 'OPTIONS' });
    check('none: OPTIONS reaches the backend (200)', options.status === 200, {
      status: options.status,
    });
    const head = await call(id, '', { method: 'HEAD' });
    check('none: HEAD reaches the backend (200)', head.status === 200, {
      status: head.status,
    });

    // (4c) ROLLBACK regression (codex P2): roll back from the none deploy to the
    // earlier platform-auth deployment. Because the secret was retained, the
    // public route must verify it again and forward signed — NOT 404 "Webhook
    // not enabled".
    stopApp(id);
    await rollbackApp(id, platformDeploymentId);
    const afterRollback = await call(id, `?secret=${secret}`, {
      headers: { 'content-type': 'application/json' },
      body: '{"after":"rollback"}',
    });
    check(
      'rollback to platform deploy: correct secret → 200 (secret survived)',
      afterRollback.status === 200,
      afterRollback,
    );
    check(
      'rollback: forwarded request is HMAC-signed again',
      afterRollback.echo?.sigValid === true,
      afterRollback.echo,
    );
    check(
      'rollback: secret still stripped before forward',
      afterRollback.echo?.secretParam === null,
      afterRollback.echo?.secretParam,
    );
    stopApp(id);

    // -- 2b) deploy validation: webhook requires a backend --
    const noBackend = manifest(id, { auth: 'none', backend: false });
    await fs.writeFile(path.join(srcDir, 'manifest.json'), noBackend);
    git(['add', '-A'], srcDir);
    git(['commit', '-m', 'f9 webhook no backend'], srcDir);
    let rejectMsg = '';
    try {
      await deployApp(id, { sourceDir: srcDir, message: 'f9 no backend' });
    } catch (e) {
      rejectMsg = (e as Error).message;
    }
    check(
      'deploy rejects a webhook app without a backend',
      rejectMsg !== '',
      rejectMsg || '(no throw)',
    );
    check(
      '  …message mentions a backend requirement',
      /backend/i.test(rejectMsg),
      rejectMsg,
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

  console.log(`\nF9 verify: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nF9 VERIFY CRASHED:', e);
  process.exit(1);
});
