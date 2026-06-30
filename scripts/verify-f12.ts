/**
 * Verify F12: app KV capability.
 *
 * Exercises the KV server module (CRUD, secret preservation, validation) and the
 * HMAC-authed backend route (signed reads/writes, plus every rejection path:
 * bad/missing/stale signature, wrong secret, unknown app). Runs against the live
 * `caps-demo` app (seed it first with kv enabled).
 *
 * RUN: direnv exec . env HATCH_DATA_DIR=../my-space-data \
 *        pnpm exec tsx scripts/verify-f12.ts
 */
import { db } from '../src/db';
import { handle } from '../src/routes/api/apps/$appId/kv/$';
import {
  countKv,
  deleteKv,
  getKv,
  KvError,
  listKv,
  setKv,
} from '../src/server/apps/kv';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  hatchSignature,
} from '../src/server/secrets';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(
      `  FAIL ${name}`,
      extra === undefined ? '' : JSON.stringify(extra),
    );
  }
}

async function expectKvError(
  name: string,
  fn: () => Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (error) {
    const ok = error instanceof KvError && error.status === status;
    check(name, ok, error instanceof KvError ? error.status : String(error));
  }
}

async function main() {
  const app = await db.query.apps.findFirst({
    where: (s, { eq }) => eq(s.slug, 'caps-demo'),
  });
  if (!app) throw new Error('seed caps-demo first (scripts/seed-caps-demo.ts)');
  const appId = app.id;
  const secret = app.signingSecret;
  check('caps-demo has kv capability', Boolean(app.capabilities?.kv));
  check('caps-demo has a signing secret', Boolean(secret), secret);
  if (!secret) {
    process.exit(1);
  }

  // Clean slate for our test keys (leave heartbeat-written keys alone).
  const TEST_KEYS = [
    'vf12-a',
    'vf12-secret',
    'vf12-del',
    'vf12-route',
    'vf12-big',
  ];
  for (const k of TEST_KEYS) await deleteKv(appId, k);

  console.log('\n— module CRUD —');
  const a = await setKv(appId, 'vf12-a', 'hello');
  check('setKv creates non-secret', a.value === 'hello' && !a.secret, a);
  const got = await getKv(appId, 'vf12-a');
  check('getKv returns value', got?.value === 'hello', got);
  check(
    'getKv missing returns null',
    (await getKv(appId, 'vf12-none')) === null,
  );

  console.log('\n— secret flag —');
  const sec = await setKv(appId, 'vf12-secret', 'sekret', { secret: true });
  check('setKv secret=true', sec.secret === true, sec);
  const sec2 = await setKv(appId, 'vf12-secret', 'sekret2');
  check(
    'overwrite without secret opt preserves secret=true',
    sec2.secret === true && sec2.value === 'sekret2',
    sec2,
  );
  const sec3 = await setKv(appId, 'vf12-secret', 'sekret3', { secret: false });
  check('explicit secret=false unsets the flag', sec3.secret === false, sec3);

  console.log('\n— validation —');
  await expectKvError(
    'key too long -> 400',
    () => setKv(appId, 'x'.repeat(513), 'v'),
    400,
  );
  await expectKvError('empty key -> 400', () => setKv(appId, '   ', 'v'), 400);
  await expectKvError(
    'control-char key -> 400',
    () => setKv(appId, 'bad\nkey', 'v'),
    400,
  );
  await expectKvError(
    'value too large -> 413',
    () => setKv(appId, 'vf12-a', 'x'.repeat(64 * 1024 + 1)),
    413,
  );

  console.log('\n— list + delete —');
  const list = await listKv(appId);
  check(
    'listKv includes our keys, sorted by key',
    list.some((r) => r.key === 'vf12-a') &&
      list.every((r, i) => i === 0 || list[i - 1].key <= r.key),
    list.map((r) => r.key),
  );
  check('countKv matches list length', (await countKv(appId)) === list.length);
  await setKv(appId, 'vf12-del', 'bye');
  check('deleteKv returns true', (await deleteKv(appId, 'vf12-del')) === true);
  check(
    'deleteKv on missing returns false',
    (await deleteKv(appId, 'vf12-del')) === false,
  );

  // --- signed backend route ---
  const base = `http://localhost/api/apps/${appId}/kv`;
  const signedReq = (method: string, key: string, body?: string): Request => {
    const ts = String(Date.now());
    const headers: Record<string, string> = {
      [HATCH_TIMESTAMP_HEADER]: ts,
      [HATCH_SIGNATURE_HEADER]: hatchSignature(secret, ts, body ?? ''),
    };
    if (body) headers['content-type'] = 'application/json';
    const url = key ? `${base}/${encodeURIComponent(key)}` : base;
    return new Request(url, { method, headers, body: body || undefined });
  };

  console.log('\n— route: signed happy paths —');
  {
    const body = JSON.stringify({ value: 'via-route', secret: false });
    const res = await handle({ request: signedReq('PUT', 'vf12-route', body) });
    check('PUT 200', res.status === 200, res.status);
    check(
      'PUT persisted value',
      (await getKv(appId, 'vf12-route'))?.value === 'via-route',
    );
  }
  {
    const res = await handle({ request: signedReq('GET', 'vf12-route') });
    const j = (await res.json()) as { value?: string };
    check(
      'GET one 200 + value',
      res.status === 200 && j.value === 'via-route',
      j,
    );
  }
  {
    const res = await handle({ request: signedReq('GET', '') });
    const j = (await res.json()) as { items?: { key: string }[] };
    check(
      'GET list 200 + items',
      res.status === 200 &&
        (j.items?.some((i) => i.key === 'vf12-route') ?? false),
      j.items?.length,
    );
  }
  {
    // The backend (signed) always sees secret plaintext — masking is UI-only.
    await setKv(appId, 'vf12-secret', 'plain-to-backend', { secret: true });
    const res = await handle({ request: signedReq('GET', 'vf12-secret') });
    const j = (await res.json()) as { value?: string; secret?: boolean };
    check(
      'GET secret returns plaintext to backend',
      j.value === 'plain-to-backend' && j.secret === true,
      j,
    );
  }
  {
    const res = await handle({ request: signedReq('DELETE', 'vf12-route') });
    check('DELETE 200', res.status === 200, res.status);
    check('DELETE removed key', (await getKv(appId, 'vf12-route')) === null);
  }

  console.log('\n— route: rejection paths —');
  {
    const ts = String(Date.now());
    const req = new Request(`${base}/vf12-a`, {
      method: 'GET',
      headers: {
        [HATCH_TIMESTAMP_HEADER]: ts,
        [HATCH_SIGNATURE_HEADER]: 'sha256=dead',
      },
    });
    check(
      'bad signature -> 403',
      (await handle({ request: req })).status === 403,
    );
  }
  {
    const req = new Request(`${base}/vf12-a`, { method: 'GET' });
    check(
      'missing signature -> 403',
      (await handle({ request: req })).status === 403,
    );
  }
  {
    const ts = String(Date.now());
    const req = new Request(`${base}/vf12-a`, {
      method: 'GET',
      headers: {
        [HATCH_TIMESTAMP_HEADER]: ts,
        [HATCH_SIGNATURE_HEADER]: hatchSignature('wrong-secret', ts, ''),
      },
    });
    check(
      'wrong secret (cross-app forgery) -> 403',
      (await handle({ request: req })).status === 403,
    );
  }
  {
    const ts = String(Date.now() - 10 * 60 * 1000);
    const req = new Request(`${base}/vf12-a`, {
      method: 'GET',
      headers: {
        [HATCH_TIMESTAMP_HEADER]: ts,
        [HATCH_SIGNATURE_HEADER]: hatchSignature(secret, ts, ''),
      },
    });
    check(
      'stale timestamp -> 403',
      (await handle({ request: req })).status === 403,
    );
  }
  {
    const ts = String(Date.now());
    const req = new Request(`http://localhost/api/apps/does-not-exist/kv/x`, {
      method: 'GET',
      headers: {
        [HATCH_TIMESTAMP_HEADER]: ts,
        [HATCH_SIGNATURE_HEADER]: hatchSignature(secret, ts, ''),
      },
    });
    check(
      'unknown app -> 404',
      (await handle({ request: req })).status === 404,
    );
  }
  {
    // Oversized body is rejected (413) before the signature is verified, so an
    // unauthenticated caller can't stream an unbounded payload into memory. The
    // body is correctly signed to prove it's rejected on size, not on auth.
    const big = JSON.stringify({ value: 'x'.repeat(1_000_001) });
    const ts = String(Date.now());
    const req = new Request(`${base}/vf12-big`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        [HATCH_TIMESTAMP_HEADER]: ts,
        [HATCH_SIGNATURE_HEADER]: hatchSignature(secret, ts, big),
      },
      body: big,
    });
    check(
      'oversized body -> 413',
      (await handle({ request: req })).status === 413,
    );
    check(
      'oversized body not persisted',
      (await getKv(appId, 'vf12-big')) === null,
    );
  }

  // Cleanup our test keys.
  for (const k of TEST_KEYS) await deleteKv(appId, k);

  console.log(
    `\n${failures === 0 ? 'ALL F12 CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('VERIFY-F12 FAILED:', e);
  process.exit(1);
});
