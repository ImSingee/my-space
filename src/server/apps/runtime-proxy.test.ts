/** Byte-preserving app proxy: Range, validators, and media response headers. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { gzipSync } from 'node:zlib';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { hatchSignature } from '../secrets';

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: async () => undefined },
      deployments: { findFirst: async () => undefined },
    },
  },
  schema: {},
}));

const { proxyAppRequest, stopApp } = await import('./runtime');

const APP_ID = 'proxy-media-app';
const DEPLOYMENT_ID = 'proxy-media-deployment';
const PREFIX = `/api/app/${APP_ID}/hook`;
const file = Buffer.from('0123456789abcdef'.repeat(64));
const etag = '"clip"';
const lastModified = 'Wed, 21 Oct 2025 00:00:00 GMT';

type SeenRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
};

type RuntimeGlobal = typeof globalThis & {
  __hatchAppRuntime__?: Map<
    string,
    {
      proc: ReturnType<typeof spawn>;
      port: number;
      deploymentId: string;
      startedAt: number;
      ready: Promise<void>;
      getLog: () => string;
    }
  >;
};

const blockedHeaders = {
  'content-security-policy': "default-src 'none'",
  'content-security-policy-report-only': "default-src 'self'",
  'strict-transport-security': 'max-age=63072000',
  'access-control-allow-origin': '*',
  'access-control-allow-credentials': 'true',
  'access-control-expose-headers': 'x-app',
  location: 'https://evil.example/phish',
  refresh: '0;url=https://evil.example',
  'www-authenticate': 'Basic realm="app"',
  'x-frame-options': 'ALLOWALL',
  'clear-site-data': '"cookies"',
  'cross-origin-opener-policy': 'unsafe-none',
  'cross-origin-embedder-policy': 'unsafe-none',
  'cross-origin-resource-policy': 'cross-origin',
  link: '</api/auth>; rel=preload',
  nel: '{"report_to":"default"}',
  'report-to': '{"group":"default","max_age":1}',
  'reporting-endpoints': 'default="https://evil.example/report"',
  'permissions-policy': 'camera=*',
  server: 'app-backend',
  'x-powered-by': 'deno',
  connection: 'close',
};

let seen: SeenRequest | undefined;
let waitForMore = Promise.resolve();
const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    res.destroy(error instanceof Error ? error : undefined);
  });
});
let port = 0;

function lastRequest(): SeenRequest {
  if (!seen) throw new Error('The backend saw no request.');
  return seen;
}

function mediaHeaders(extra: Record<string, string> = {}) {
  return {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    etag,
    'last-modified': lastModified,
    'cache-control': 'public, max-age=60',
    expires: 'Thu, 01 Jan 2026 00:00:00 GMT',
    vary: 'accept',
    'content-disposition': 'inline; filename="clip.mp4"',
    'content-language': 'en',
    ...extra,
  };
}

function write(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
  body?: Buffer,
) {
  res.writeHead(status, {
    ...blockedHeaders,
    'set-cookie': ['session=evil', 'other=1'],
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function unsatisfiable(res: ServerResponse) {
  write(res, 416, {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'content-range': `bytes */${file.length}`,
    'content-length': '0',
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  seen = {
    method: req.method ?? 'GET',
    url: `${url.pathname}${url.search}`,
    headers: req.headers,
    body,
  };
  const path = url.pathname;
  if (path.endsWith('/slow-stream')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      connection: 'close',
    });
    res.write(Buffer.from([1]));
    await waitForMore;
    res.end(Buffer.from([2]));
    return;
  }
  if (path.endsWith('/gzip')) {
    const gzip = gzipSync(Buffer.from('video-bytes'));
    write(
      res,
      200,
      {
        'content-type': 'video/mp4',
        'content-encoding': 'gzip',
        'content-length': String(gzip.length),
        'accept-ranges': 'bytes',
      },
      gzip,
    );
    return;
  }
  if (path.endsWith('/echo-body')) {
    write(
      res,
      200,
      {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      },
      body,
    );
    return;
  }
  if (path.endsWith('/rpc')) {
    write(
      res,
      200,
      {
        'content-type': 'application/grpc-web+proto',
        'grpc-status': '0',
        'grpc-message': 'ok',
        'connect-protocol-version': '1',
        'connect-content-encoding': 'gzip',
        'connect-accept-encoding': 'gzip',
        'grpc-encoding': 'gzip',
        'grpc-accept-encoding': 'gzip',
        'content-length': '2',
      },
      Buffer.from('{}'),
    );
    return;
  }
  if (path.endsWith('/redirect')) {
    write(
      res,
      302,
      { 'content-type': 'text/plain', 'content-length': '2' },
      Buffer.from('go'),
    );
    return;
  }
  if (path.endsWith('/empty')) {
    write(res, 204, {});
    return;
  }
  if (path.endsWith('/sniff')) {
    write(
      res,
      200,
      {
        'content-type': 'text/plain',
        'content-length': '2',
        'x-content-type-options': 'bogus',
      },
      Buffer.from('ok'),
    );
    return;
  }
  if (!path.endsWith('/media')) {
    write(res, 404, { 'content-type': 'text/plain', 'content-length': '0' });
    return;
  }
  if (req.method === 'HEAD') {
    write(res, 200, mediaHeaders({ 'content-length': String(file.length) }));
    return;
  }
  if (req.headers['if-none-match'] === etag) {
    write(res, 304, {
      etag,
      'cache-control': 'public, max-age=60',
      'last-modified': lastModified,
      expires: 'Thu, 01 Jan 2026 00:00:00 GMT',
      'content-length': String(file.length),
    });
    return;
  }
  const rangeHeader = req.headers.range;
  const range = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  const ifRange = req.headers['if-range'];
  const honorRange =
    range !== undefined && (ifRange === undefined || ifRange === etag);
  if (!honorRange) {
    write(
      res,
      200,
      mediaHeaders({ 'content-length': String(file.length) }),
      file,
    );
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
  if (!match || (match[1] === '' && match[2] === '')) {
    unsatisfiable(res);
    return;
  }
  const suffix = match[1] === '';
  const start = suffix
    ? Math.max(file.length - Number(match[2]), 0)
    : Number(match[1]);
  const end = suffix
    ? file.length - 1
    : match[2] === ''
      ? file.length - 1
      : Number(match[2]);
  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start >= file.length ||
    end < start
  ) {
    unsatisfiable(res);
    return;
  }
  const bounded = Math.min(end, file.length - 1);
  const slice = file.subarray(start, bounded + 1);
  write(
    res,
    206,
    mediaHeaders({
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${bounded}/${file.length}`,
    }),
    slice,
  );
}

function hook(path: string, init?: RequestInit) {
  return new Request(`https://hatch.test${PREFIX}${path}`, init);
}

function proxy(
  request: Request,
  options: { sign?: boolean; stripSecret?: boolean } = {},
) {
  return proxyAppRequest(APP_ID, request, PREFIX, '/__webhook', {
    expectedDeploymentId: DEPLOYMENT_ID,
    ...(options.sign ? { signWithSecret: 'signing-secret' } : {}),
    ...(options.stripSecret ? { stripSecretParam: true } : {}),
  });
}

function expectDroppedSecurityHeaders(response: Response) {
  for (const name of [
    'set-cookie',
    ...Object.keys(blockedHeaders),
    'transfer-encoding',
    'keep-alive',
    'trailer',
  ]) {
    expect({ name, value: response.headers.get(name) }).toEqual({
      name,
      value: null,
    });
  }
  expect(response.headers.getSetCookie()).toEqual([]);
}

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The media fixture failed to listen.');
  }
  port = address.port;
});

beforeEach(() => {
  seen = undefined;
  waitForMore = Promise.resolve();
  const backends = ((globalThis as RuntimeGlobal).__hatchAppRuntime__ ??=
    new Map());
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
    stdio: 'ignore',
  });
  proc.unref();
  backends.set(APP_ID, {
    proc,
    port,
    deploymentId: DEPLOYMENT_ID,
    startedAt: Date.now(),
    ready: Promise.resolve(),
    getLog: () => '',
  });
});

afterEach(() => {
  stopApp(APP_ID);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('app backend media proxy', () => {
  it('forwards Range and returns the partial body with matching length', async () => {
    const response = await proxy(
      hook('/media', {
        headers: {
          range: 'bytes=0-3',
          'if-range': etag,
          'accept-encoding': 'gzip, deflate, br',
          cookie: 'session=platform',
          authorization: 'Bearer platform',
          'x-api-key': 'platform-key',
        },
      }),
    );

    const request = lastRequest();
    expect(request.url).toBe('/__webhook/media');
    expect(request.headers.range).toBe('bytes=0-3');
    expect(request.headers['if-range']).toBe(etag);
    expect(request.headers['accept-encoding']).toBe('identity');
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(response.status).toBe(206);
    expect(response.statusText).toBe('Partial Content');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-3/${file.length}`,
    );
    expect(response.headers.get('content-length')).toBe('4');
    expect(response.headers.get('content-disposition')).toBe(
      'inline; filename="clip.mp4"',
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(response.headers.get('etag')).toBe(etag);
    expect(response.headers.get('last-modified')).toBe(lastModified);
    expect(response.headers.get('expires')).toBe(
      'Thu, 01 Jan 2026 00:00:00 GMT',
    );
    expect(response.headers.get('vary')).toBe('accept');
    expect(response.headers.get('content-language')).toBe('en');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-encoding')).toBeNull();
    expectDroppedSecurityHeaders(response);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('0123');
    expect(response.headers.get('content-length')).toBe(String(body.length));

    const suffix = await proxy(
      hook('/media', { headers: { range: 'bytes=-4' } }),
    );
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(
      `bytes ${file.length - 4}-${file.length - 1}/${file.length}`,
    );
    expect(Buffer.from(await suffix.arrayBuffer()).toString()).toBe('cdef');
  });

  it('passes conditional validators through for full, 304, 416, and HEAD responses', async () => {
    const full = await proxy(
      hook('/media', {
        headers: { range: 'bytes=0-3', 'if-range': '"other"' },
      }),
    );
    expect(lastRequest().headers['if-range']).toBe('"other"');
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe(String(file.length));
    expect(Buffer.from(await full.arrayBuffer())).toEqual(file);

    const notModified = await proxy(
      hook('/media', {
        headers: {
          'if-none-match': etag,
          'if-match': etag,
          'if-modified-since': lastModified,
          'if-unmodified-since': 'Thu, 22 Oct 2025 00:00:00 GMT',
          'accept-encoding': 'gzip',
        },
      }),
    );
    const validators = lastRequest().headers;
    expect(validators['if-none-match']).toBe(etag);
    expect(validators['if-match']).toBe(etag);
    expect(validators['if-modified-since']).toBe(lastModified);
    expect(validators['if-unmodified-since']).toBe(
      'Thu, 22 Oct 2025 00:00:00 GMT',
    );
    expect(validators['accept-encoding']).toBe('identity');
    expect(notModified.status).toBe(304);
    expect(notModified.statusText).toBe('Not Modified');
    expect(notModified.body).toBeNull();
    expect(notModified.headers.get('etag')).toBe(etag);
    expect(notModified.headers.get('cache-control')).toBe('public, max-age=60');
    expect(notModified.headers.get('content-length')).toBe(String(file.length));
    expect(Buffer.from(await notModified.arrayBuffer())).toHaveLength(0);

    const missing = await proxy(
      hook('/media', { headers: { range: 'bytes=5000-6000' } }),
    );
    expect(lastRequest().headers.range).toBe('bytes=5000-6000');
    expect(missing.status).toBe(416);
    expect(missing.headers.get('content-range')).toBe(`bytes */${file.length}`);
    expect(Buffer.from(await missing.arrayBuffer())).toHaveLength(0);

    const head = await proxy(hook('/media', { method: 'HEAD' }));
    expect(lastRequest().method).toBe('HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-type')).toBe('video/mp4');
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('content-length')).toBe(String(file.length));
    expect(head.headers.get('content-disposition')).toBe(
      'inline; filename="clip.mp4"',
    );
  });

  it('forwards an encoded body without changing its length', async () => {
    const gzip = gzipSync(Buffer.from('video-bytes'));
    const response = await proxy(
      hook('/gzip', { headers: { 'accept-encoding': 'gzip, deflate, br' } }),
    );
    expect(lastRequest().headers['accept-encoding']).toBe('identity');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toEqual(gzip);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBe(String(gzip.length));
    expect(body.length).not.toBe(Buffer.from('video-bytes').length);
    expectDroppedSecurityHeaders(response);
  });

  it('streams a response body before the backend finishes it', async () => {
    let release = () => {};
    waitForMore = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const response = await proxy(hook('/slow-stream'));
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('transfer-encoding')).toBeNull();
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected a streamed body.');
      const first = await reader.read();
      expect(Buffer.from(first.value ?? [])).toEqual(Buffer.from([1]));
      release();
      const second = await reader.read();
      expect(Buffer.from(second.value ?? [])).toEqual(Buffer.from([2]));
      expect((await reader.read()).done).toBe(true);
    } finally {
      release();
    }
  });

  it('keeps raw request bytes and signs a ranged GET without platform credentials', async () => {
    const payload = gzipSync(Buffer.from([0, 255, 10, 13]));
    const echoed = await proxy(
      hook('/echo-body', {
        method: 'POST',
        headers: {
          'content-encoding': 'gzip',
          'content-type': 'application/octet-stream',
        },
        body: payload,
      }),
    );
    expect(lastRequest().headers['content-encoding']).toBe('gzip');
    expect(lastRequest().body).toEqual(payload);
    expect(Buffer.from(await echoed.arrayBuffer())).toEqual(payload);
    expect(echoed.headers.get('content-length')).toBe(String(payload.length));

    const signed = await proxy(
      hook('/media?secret=hide-me&track=1', {
        headers: {
          range: 'bytes=0-1',
          cookie: 'session=platform',
          authorization: 'Bearer nope',
        },
      }),
      { sign: true, stripSecret: true },
    );
    const forwarded = lastRequest();
    expect(forwarded.url).toBe('/__webhook/media?track=1');
    expect(forwarded.headers.range).toBe('bytes=0-1');
    expect(forwarded.headers.cookie).toBeUndefined();
    expect(forwarded.headers.authorization).toBeUndefined();
    const timestamp = forwarded.headers['x-hatch-timestamp'];
    expect(typeof timestamp).toBe('string');
    expect(forwarded.headers['x-hatch-signature']).toBe(
      hatchSignature('signing-secret', String(timestamp), Buffer.alloc(0)),
    );
    expect(signed.status).toBe(206);
    expect(Buffer.from(await signed.arrayBuffer()).toString()).toBe('01');
  });

  it('keeps RPC framing and null-body statuses without opening redirects', async () => {
    const rpc = await proxy(hook('/rpc'));
    expect(rpc.headers.get('content-type')).toBe('application/grpc-web+proto');
    expect(rpc.headers.get('grpc-status')).toBe('0');
    expect(rpc.headers.get('grpc-message')).toBe('ok');
    expect(rpc.headers.get('connect-protocol-version')).toBe('1');
    expect(rpc.headers.get('connect-content-encoding')).toBe('gzip');
    expect(rpc.headers.get('connect-accept-encoding')).toBe('gzip');
    expect(rpc.headers.get('grpc-encoding')).toBe('gzip');
    expect(rpc.headers.get('grpc-accept-encoding')).toBe('gzip');
    expect(rpc.headers.get('location')).toBeNull();
    expect(await rpc.text()).toBe('{}');

    const redirect = await proxy(hook('/redirect'));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBeNull();
    expect(redirect.headers.get('refresh')).toBeNull();
    expect(await redirect.text()).toBe('go');

    const empty = await proxy(hook('/empty'));
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();

    const sniff = await proxy(hook('/sniff'));
    expect(sniff.headers.get('x-content-type-options')).toBeNull();
    expect(await sniff.text()).toBe('ok');
  });
});
