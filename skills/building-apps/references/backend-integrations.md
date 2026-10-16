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
worker entries, native addons, FFI, runtime sidecars, and packages that expect
their source-relative resources are unsupported.

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

- `platform`: the public caller supplies the platform-managed secret. Hatch
  verifies and removes it, then signs the forwarded request with
  `HATCH_SIGNING_SECRET`. Verify the HMAC over
  `<timestamp>.<exact raw body bytes>`; use empty bytes for GET/HEAD.
- `none`: Hatch forwards the request without platform authentication or
  signature. Verify the third-party provider's own authentication in the App.

Preserve exact raw bytes when verifying signatures; decoding and re-encoding a
binary or non-canonical body changes the HMAC input.

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
