# Backend integrations

Read this reference for backend RPC, cron, webhook, long-running processes, or
calling top-level Workflows.

## Deno Connect backend

The platform injects `PORT`. It injects `DATABASE_URL` only with the database
capability. Import generated code with an explicit `.ts` extension.

```ts
import http from 'node:http';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import type { ConnectRouter } from '@connectrpc/connect';
import { TodoService } from '../gen/service_pb.ts';

function routes(router: ConnectRouter) {
  router.service(TodoService, {
    async list() {
      return { todos: [] };
    },
  });
}

const port = Number(Deno.env.get('PORT') ?? '8080');
http.createServer(connectNodeAdapter({ routes })).listen(port);
```

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

Wrap the Connect handler when serving the webhook path:

```ts
const connect = connectNodeAdapter({ routes });

http
  .createServer(async (request, response) => {
    if ((request.url ?? '/').startsWith('/__webhook')) {
      // Authenticate according to the selected mode, then handle the request.
      response.writeHead(200);
      response.end('ok');
      return;
    }
    connect(request, response);
  })
  .listen(port);
```

## Long-running mode

Set `backendMode: "long-running"` for in-memory state, WebSockets, or background
loops. Hatch starts it at deploy and restarts it after an exit. The default
`serverless` mode starts on demand and reuses the process when possible.

## Calling top-level Workflows

Apps call Workflows created in the Workflow module; they do not define
Workflows themselves. Declare allowed targets at the manifest top level:

```json
{
  "workflows": [
    { "workflow": "daily-digest" },
    { "workflow": "send-report", "alias": "report" }
  ]
}
```

Each target must already be deployed with its webhook trigger enabled. The
platform injects `HATCH_WORKFLOWS`, a JSON map from alias to
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
