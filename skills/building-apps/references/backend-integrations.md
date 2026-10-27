# Backend integrations

Read this reference for backend RPC, cron, webhook, long-running processes, or
calling top-level Workflows.

## Deno Fetch/Connect backend

For a manifest declaring `backend.runtime: "deno-serve"`, the platform starts the
bundled backend with `deno serve` and owns its loopback listener. Default-export
a Fetch handler; do not call `listen()` or read `PORT`. The platform injects
`DATABASE_URL` only when the database capability is enabled and a deployment
has provisioned the database. Import generated code with an explicit `.ts`
extension.

```ts
import { createConnectRouter, type ConnectRouter } from '@connectrpc/connect';
import { compressionBrotli, compressionGzip } from '@connectrpc/connect-node';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { TodoService } from '../gen/service_pb.ts';

function routes(router: ConnectRouter) {
  router.service(TodoService, {
    async list() {
      return { todos: [] };
    },
  });
}

function createConnectFetchHandler(
  registerRoutes: (router: ConnectRouter) => void,
) {
  const router = createConnectRouter({
    acceptCompression: [compressionGzip, compressionBrotli],
  });
  registerRoutes(router);
  const handlers = new Map(
    router.handlers.map((handler) => [
      handler.requestPath,
      createFetchHandler(handler, { httpVersion: '1.1' }),
    ]),
  );
  return async (request: Request): Promise<Response> => {
    const handler = handlers.get(new URL(request.url).pathname);
    return handler?.(request) ?? new Response('Not found', { status: 404 });
  };
}

const handleRequest = createConnectFetchHandler(routes);
export default {
  fetch: handleRequest,
} satisfies Deno.ServeDefaultExport;
```

This Fetch bridge supports Hatch's Connect and gRPC-Web traffic, including
streaming responses. Native gRPC is not part of the App backend contract because
the Fetch `Response` API cannot represent HTTP trailers.

### Self-listening backend

For `backend.runtime: "deno-run"` or an omitted runtime, Hatch starts the backend
with `deno run` and injects `PORT`:

```ts
import http from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';

const port = Number(Deno.env.get('PORT') ?? '8080');
http.createServer(connectNodeAdapter({ routes })).listen(port, '127.0.0.1');
```

To switch to Fetch, replace the self-listening adapter with the default export
above and select `backend.runtime: "deno-serve"` in the same source change.
Preserve `compatibilityVersion`. Register `compressionGzip` and
`compressionBrotli` as shown to retain compressed Connect and gRPC-Web traffic,
refresh `deno.lock` when dependencies change, validate, and redeploy. Upgrade
all serving platform processes before deploying Apps using the new mode;
older platform releases always invoke `deno run`.

Keep backend imports statically bundleable. Computed dynamic imports, separate
worker entries, npm native addons, and packages that expect unpackaged
source-relative resources are unsupported. FFI via `Deno.dlopen` can use an
explicitly authorized `backend.extraPermissions` flag such as
`--allow-ffi=backend/assets/library.so`; host commands/sidecars require scoped
`--allow-run` and a reviewed host executable or packaged asset. Relative paths
resolve from the artifact directory. These permissions must be strictly
necessary: use network, storage, KV, Data Tables, Workflow calls, or JS/Wasm
instead whenever possible. Before writing or deploying any such declaration,
explain the exact flags, necessity, and host-access risks and obtain explicit
user authorization; repeat this for every addition, broadening, or modification.
Apps and the platform share the same OS user, so these permissions can expose
platform credentials and other Apps' data.

## Invoking a deployed backend

Use the current CLI profile or complete environment credentials to call a deployed
App method without local generated stubs:

```sh
hatch app invoke backend my-app app.v1.TodoService/ListTodos --json
hatch app invoke backend my-app app.v1.TodoService/CreateTodo --file request.json --json
```

Backend invocation uses the existing `/api/app/<id>/rpc/<Service>/<Method>`
Connect endpoint and unary JSON. The default request is `{}`; `--file <path|->`
reads valid JSON while preserving its original bytes and meaningful JSON values.
It accepts native Better Auth session credentials, user API keys or live Run JWTs.
Explicit keys take precedence over Bearer credentials, then Cookie; an invalid
explicit credential cannot fall back. Platform credentials are stripped before
App code and the platform signs exact raw request bytes with the App HMAC key.
Connect code, HTTP status and structured error details remain available in CLI
JSON failures with platform credentials redacted.

The CLI refuses streaming/non-JSON protocols and redirects and never retries;
a timeout or cancellation may follow an App mutation. Direct Connect/gRPC-Web
clients retain binary, compressed and streaming support through the runtime.
Use `hatch app invoke webhook` below for plain HTTP/raw-byte handlers.

## Cron

Enable `cron` and `backend`, then declare a proto RPC method for each job. The
method must exist on the service named by `rpc.service`.

```json
{
  "capabilities": { "backend": true, "cron": true },
  "rpc": {
    "proto": "proto/service.proto",
    "service": "app.v1.MaintenanceService"
  },
  "cron": [
    { "name": "cleanup", "schedule": "0 3 * * *", "method": "RunCleanup" }
  ]
}
```

Scheduled methods are also reachable through the user RPC proxy, so authenticate
the cron call. The platform injects `HATCH_SIGNING_SECRET` and sends:

- `x-hatch-cron`: job name
- `x-hatch-timestamp`: Unix milliseconds
- `x-hatch-signature`: `sha256=<hex HMAC-SHA256(timestamp + "." + jobName)>`

Reject missing headers, timestamps outside a short replay window, and signatures
that do not match in constant time.

Regular platform-proxied RPC calls are also signed. Their HMAC payload is
`<timestamp>.<rawBodyBytes>`, so sensitive RPCs can verify that the caller passed
through the platform.

## Webhook

Enable both `webhook` and `backend`. Requests to the public
`/api/app/<id>/hook` endpoint and its subpaths are forwarded to
`/__webhook/...` as plain HTTP.

Select the platform auth mode in the top-level manifest block:

```json
{ "webhook": { "auth": "platform" } }
```

- `platform`: accepts the existing App webhook secret or native platform
  credentials (Better Auth Cookie/Bearer session, user API key in `x-api-key`,
  or live Run JWT in Bearer). The platform verifies them and signs the forwarded
  raw body with `HATCH_SIGNING_SECRET`; verify the HMAC over
  `<timestamp>.<exact raw body bytes>` (empty bytes for GET/HEAD).
- `none`: no platform authentication and no platform signature. Invalid incoming
  Authorization/x-api-key values are ignored and stripped. The App must verify
  its own provider signature or dedicated private token; possession of a
  platform credential does not bypass that check.

Both modes strip Authorization and x-api-key, in all casing, as well as
Cookie, `x-hatch-*` and forwarding/hop-by-hop headers. `auth: none` does not mean
full header passthrough. Authorization and x-api-key cannot implement App-private
or third-party authentication. Use a dedicated nonreserved header such as
`X-App-Token` or a provider signature header, or a signature over the raw body.
Removed values are not copied to another header.

## Serving media from a webhook

A webhook response is streamed back to the caller, so the App can serve files
from `STORAGE_DIR` (video, audio, images, and downloads) on `/__webhook/...`.
The platform forwards `Range`, `If-Range`, `If-Match`, `If-None-Match`,
`If-Modified-Since`, and `If-Unmodified-Since`. It asks the backend for
`Accept-Encoding: identity` and does not compress or decompress the body.
Implement ranges on the raw file bytes.

- `200` with `Accept-Ranges: bytes` for the whole object.
- `206` with `Content-Type`, `Content-Range`, and `Content-Length` for a
  satisfiable range.
- `416` with `Content-Range: bytes */<size>` when the range cannot be
  satisfied.
- `304` with no body when `ETag` or `Last-Modified` matches.
- `HEAD` with the same headers `GET` would send and no body.

`Content-Disposition`, `Cache-Control`, `ETag`, `Last-Modified`, `Expires`,
and `Vary` are forwarded. `Content-Encoding` is forwarded only when the App
itself sent an encoded body; do not gzip a byte range.
`X-Content-Type-Options: nosniff` is forwarded when that is the value.
`Set-Cookie`, CORS, CSP, HSTS,
COOP/COEP/CORP, and `Location` are not. An `auth: none` URL can be opened by a
browser or an external player such as VLC or IINA, because those clients send
`Range` without platform credentials. `auth: platform` still requires a
platform credential on every request, which those players do not send.

In platform mode credential selection is fail-closed: explicit `x-api-key`
wins over Authorization (Bearer session or Run JWT), with no Cookie/secret
fallback on failure. Otherwise `x-hatch-secret` wins over `?secret=` (even an
empty header wins). The `secret` query parameter is removed only when it actually
authenticated the request. With no explicit credential or secret, a valid Cookie
session requires trusted Origin or positive same-origin browser fetch metadata;
cross-site and missing-origin/missing-metadata Cookie calls are denied, including
GET. Native callers should use explicit credentials. No CORS access is added.

Invoke through the existing endpoint using the CLI's current profile or complete
environment credentials, without reading the App webhook secret:

```sh
hatch app invoke webhook my-app --path provider/events --file payload.bin \
  --content-type application/octet-stream --header 'X-App-Token: <app-token>'
hatch app invoke webhook my-app --file - --query 'delivery=one two' --json
```

Default: POST, empty raw body, `application/octet-stream`. `--file` streams exact
file/stdin bytes. GET/HEAD reject `--file`. `--path` accepts relative segments,
not URLs, percent escapes, traversal, query or fragments; repeat `--query name=value`
for safely encoded query parameters. Repeat `--header` for nonreserved headers;
platform credential/routing/signature headers cannot be overridden. The CLI sends
platform credentials to the runtime endpoint, where they are stripped before App
code. Non-JSON output is the exact response body (use shell redirection to save
binary output). `--json` returns `ok`, `status`, `contentType`,
`bodyEncoding: "base64"`, and the base64 `body`. Non-2xx exits nonzero. Calls are
never retried and redirects are refused; a timeout may have an unknown outcome.

Preserve exact raw bytes when verifying signatures; decoding and re-encoding a
binary or non-canonical body changes the HMAC input. For example, in `none` mode
verify a provider's `X-Provider-Signature` against `await request.arrayBuffer()`
or compare `X-App-Token` with your App-owned secret before processing. Keep these
checks in place when the caller also supplies a platform key.

In a `"deno-serve"` backend, route the webhook before the Connect handler:

```ts
const connect = createConnectFetchHandler(routes);

async function handleRequest(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith('/__webhook')) {
    // Authenticate according to the selected mode, then handle the request.
    return new Response('ok');
  }
  return connect(request);
}

export default {
  fetch: handleRequest,
} satisfies Deno.ServeDefaultExport;
```

## Long-running mode

Set `backendMode: "long-running"` for in-memory state, WebSockets, or background
loops. Hatch starts it at deploy and restarts it after an exit. The default
`serverless` mode starts on demand and reuses the process when possible.

## Calling top-level Workflows

Apps call Workflows created in the Workflow module; they do not define
Workflows themselves. Use `list_workflows` and copy each target's exact
`id` into `workflow`; a Workflow slug does not resolve here. Add a readable
`alias` for the stable key used by backend code:

```json
{
  "workflows": [
    {
      "workflow": "01k43s9az5t2qpy7ejf0hm6vwc",
      "alias": "dailyDigest"
    }
  ]
}
```

Each target must already be deployed with its webhook trigger enabled. The
platform injects `HATCH_WORKFLOWS`, a JSON map from alias (or the Workflow id
when no alias is declared) to
`{ workflow, name, url, secret }`.

```ts
type WorkflowTarget = {
  workflow: string;
  name: string;
  url: string;
  secret: string;
};

const workflows = JSON.parse(Deno.env.get('HATCH_WORKFLOWS') ?? '{}') as Record<
  string,
  WorkflowTarget
>;

async function callWorkflow(alias: string, input: unknown) {
  const workflow = workflows[alias];
  if (!workflow) throw new Error(`Workflow ${alias} is unavailable.`);
  const response = await fetch(workflow.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hatch-secret': workflow.secret,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Workflow returned ${response.status}.`);
  return (await response.json()) as { runId: string; status: string };
}
```

The call enqueues a run and returns without waiting for completion. Keep the
injected registry and secret in backend code; never send them to the frontend.
