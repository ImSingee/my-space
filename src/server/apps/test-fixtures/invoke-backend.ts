import type { GenService } from '@bufbuild/protobuf/codegenv2';
/** Real Connect App fixture, bundled for Deno by the integration/acceptance tests. */
import {
  create,
  createFileRegistry,
  fromJson,
  toJson,
  type JsonValue,
} from '@bufbuild/protobuf';
import {
  FileDescriptorProtoSchema,
  file_google_protobuf_struct,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { createConnectRouter, Code, ConnectError } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { compressionGzip } from '@connectrpc/connect-node';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

export const service = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: 'backend-invoke-fixture.proto',
    package: 'fixture.v1',
    syntax: 'proto3',
    dependency: ['google/protobuf/struct.proto'],
    service: [
      {
        name: 'EchoService',
        method: ['Echo', 'Identity', 'Fail', 'Slow', 'Stream'].map((name) => ({
          name,
          inputType: '.google.protobuf.Value',
          outputType: '.google.protobuf.Value',
          serverStreaming: name === 'Stream',
        })),
      },
    ],
  }),
  () => file_google_protobuf_struct,
).getService('fixture.v1.EchoService')! as GenService<{
  echo: {
    methodKind: 'unary';
    input: typeof ValueSchema;
    output: typeof ValueSchema;
  };
  identity: {
    methodKind: 'unary';
    input: typeof ValueSchema;
    output: typeof ValueSchema;
  };
  fail: {
    methodKind: 'unary';
    input: typeof ValueSchema;
    output: typeof ValueSchema;
  };
  slow: {
    methodKind: 'unary';
    input: typeof ValueSchema;
    output: typeof ValueSchema;
  };
  stream: {
    methodKind: 'server_streaming';
    input: typeof ValueSchema;
    output: typeof ValueSchema;
  };
}>;

const calls: Record<string, number> = {};
let cancellations = 0;
const router = createConnectRouter({
  grpc: false,
  acceptCompression: [compressionGzip],
  compressMinBytes: 1,
});
router.service(service, {
  echo: (input, context) =>
    fromJson(ValueSchema, {
      input: toJson(ValueSchema, input),
      observed: JSON.parse(context.requestHeader.get('x-fixture-observed')!),
    }),
  identity: (input) => input,
  fail: (input) => {
    throw new ConnectError(
      `App failure: ${JSON.stringify(toJson(ValueSchema, input))}`,
      Code.FailedPrecondition,
      undefined,
      [
        {
          desc: ValueSchema,
          value: fromJson(ValueSchema, {
            reason: 'App-specific detail',
            zero: 0,
          }),
        },
      ],
    );
  },
  slow: async (_input, context) => {
    await delay(10000, undefined, { signal: context.signal });
    return fromJson(ValueSchema, { completed: true });
  },
  stream: async function* () {
    yield fromJson(ValueSchema, { sequence: 1 });
    await delay(50);
    yield fromJson(ValueSchema, { sequence: 2 });
  },
});
const handlers = new Map(
  router.handlers.map((handler) => [
    handler.requestPath,
    createFetchHandler(handler, { httpVersion: '1.1' }),
  ]),
);

export default {
  async fetch(request: Request) {
    const bytes = Buffer.from(await request.clone().arrayBuffer());
    const timestamp = request.headers.get('x-hatch-timestamp') ?? '';
    const signature = request.headers.get('x-hatch-signature');
    const expected = `sha256=${createHmac(
      'sha256',
      process.env.HATCH_SIGNING_SECRET ?? '',
    )
      .update(`${timestamp}.`)
      .update(bytes)
      .digest('hex')}`;
    const path = new URL(request.url).pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    request.signal.addEventListener(
      'abort',
      () => {
        cancellations++;
      },
      { once: true },
    );
    const observed = {
      calls: { ...calls },
      cancellations,
      headers: Object.fromEntries(request.headers),
      rawBase64: bytes.toString('base64'),
      signatureValid: signature === expected,
      platformEnvPresent: [
        'HATCH_CLI_TOKEN',
        'HATCH_CLI_API_KEY',
        'AGENT_RUNNER_TOKEN',
        'SECRET',
        'BETTER_AUTH_SECRET',
      ].some((name) => !!process.env[name]),
    };
    if (path === '/fixture.v1.EchoService/Raw' || path.startsWith('/__webhook'))
      return Response.json(observed);
    if (path === '/fixture.v1.EchoService/Framed')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([2, 0, 0, 0, 2, 123, 125]));
          },
        }),
        {
          headers: { 'content-type': 'application/connect+json' },
        },
      );
    if (path === '/fixture.v1.EchoService/Redirect')
      return Response.redirect('http://127.0.0.1:1/credential-trap');
    if (path === '/fixture.v1.EchoService/Invalid')
      return new Response('{invalid', {
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/fixture.v1.EchoService/NonConnectError')
      return new Response(bytes, {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    const headers = new Headers(request.headers);
    headers.set('x-fixture-observed', JSON.stringify(observed));
    return (
      handlers.get(path)?.(new Request(request, { headers })) ??
      new Response('Not found', { status: 404 })
    );
  },
};
export function value(json: JsonValue) {
  return fromJson(ValueSchema, json);
}
