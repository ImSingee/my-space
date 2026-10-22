import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() =>
  vi.fn<(input: { id: string }) => Promise<{ id: string }>>(),
);
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, platformClient: () => ({ apps: { get: lookup } }) };
});
import { runWebhook, webhookHeaders, webhookSuffix } from './webhook';

let server: Server;
let directory: string;
let url: string;
let calls: {
  path: string;
  method?: string;
  body: Buffer;
  headers: Record<string, unknown>;
}[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hatch-webhook-cli-'));
  calls = [];
  lookup.mockResolvedValue({ id: 'canonical-id' });
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      path: request.url!,
      method: request.method,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    if (request.url?.includes('/redirect')) {
      response.writeHead(307, { location: '/unexpected' });
      response.end();
    } else {
      response.writeHead(request.url?.includes('/failure') ? 422 : 200, {
        'content-type': 'application/octet-stream',
      });
      response.end(Buffer.from([0, 255, 128, 10]));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  url = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('HATCH_CLI_URL', url);
  vi.stubEnv('HATCH_CLI_TOKEN', 'fixture-session');
  vi.stubEnv('HATCH_CLI_API_KEY', undefined);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('webhook target and credential boundary', () => {
  it('rejects target escapes and reserved credential/routing overrides', () => {
    for (const suffix of [
      '../rpc',
      '/rpc',
      '//evil.test',
      'http://evil.test',
      'a/../b',
      'a%2fb',
      '%252e%252e',
      'a?secret=x',
      'a#b',
      'a\\b',
      'a//b',
    ])
      expect(() => webhookSuffix(suffix)).toThrow(
        /relative segments|nonreserved header/,
      );
    for (const name of [
      'Authorization',
      'X-API-Key',
      'Cookie',
      'x-Hatch-Signature',
      'X-HATCH-anything',
      'Host',
      'Connection',
      'X-Forwarded-Host',
      'Origin',
      'Sec-Fetch-Site',
      'Content-Length',
    ])
      expect(() => webhookHeaders([`${name}: injected`])).toThrow(
        /relative segments|nonreserved header/,
      );
    expect(() =>
      webhookHeaders(['X-App-Token: value\r\nAuthorization: injected']),
    ).toThrow(/relative segments|nonreserved header/);
  });

  it('calls only the canonical runtime URL and preserves binary file/response bytes', async () => {
    const payload = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(directory, 'body.bin'), payload);
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runWebhook(
      [
        'app',
        'invoke',
        'webhook',
        'my-slug',
        '--workdir',
        directory,
        '--file',
        'body.bin',
        '--path',
        'provider/events',
        '--query',
        'delivery=a&b?#%',
        '--header',
        'X-App-Token: app-private',
        '--json',
      ],
      0,
      new AbortController().signal,
    );
    expect(lookup).toHaveBeenCalledWith({ id: 'my-slug' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/api/app/canonical-id/hook/provider/events?delivery=a%26b%3F%23%25',
      method: 'POST',
      body: payload,
      headers: {
        authorization: 'Bearer fixture-session',
        'x-app-token': 'app-private',
        'content-type': 'application/octet-stream',
      },
    });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      ok: true,
      status: 200,
      contentType: 'application/octet-stream',
      bodyEncoding: 'base64',
      body: payload.toString('base64'),
    });
  });

  it('emits exact raw response bytes and HTTP failure without retries', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await runWebhook(
      ['app', 'invoke', 'webhook', 'id', '--path', 'failure'],
      0,
      new AbortController().signal,
    );
    expect(output).toHaveBeenCalledWith(new Uint8Array([0, 255, 128, 10]));
    expect(errors).toHaveBeenCalledWith('Webhook returned HTTP 422.\n');
    expect(process.exitCode).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.length).toBe(0);
  });

  it('refuses redirects without reaching a second target', async () => {
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id', '--path', 'redirect'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'outcome_unknown', exitCode: 7 });
    expect(calls).toHaveLength(1);
  });

  it('rejects supplied GET/HEAD bodies, unsupported methods and invalid env before invocation', async () => {
    for (const method of ['GET', 'HEAD'])
      await expect(
        runWebhook(
          ['app', 'invoke', 'webhook', 'id', '--method', method, '--file', '-'],
          0,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'invalid_body' });
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id', '--method', 'TRACE'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid_method' });
    vi.stubEnv('HATCH_CLI_API_KEY', 'ambiguous');
    await expect(
      runWebhook(
        ['app', 'invoke', 'webhook', 'id'],
        0,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'incomplete_env' });
    expect(calls).toHaveLength(0);
  });
});
