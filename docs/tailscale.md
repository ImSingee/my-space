# Tailscale access

Open **Settings → Tailscale** to connect Hatch to your private Tailscale network.
Enter a device name and select **Connect Tailscale**. A connection window opens
and automatically takes you to Tailscale authorization when needed. If the
device is already authorized, the waiting window closes automatically. The
panel keeps updating while you authorize and, if required, approve the device
in your Tailscale admin console. If your browser blocks the window or you close
it, use **Continue authorization** to resume. **Cancel connection** stops a
pending connection.

Enable MagicDNS and HTTPS certificates in your
[Tailscale DNS settings](https://login.tailscale.com/admin/dns). Your tailnet
access policy must allow the intended users to reach this device on TCP 443.
Once the certificate and listener are ready, the panel shows a private HTTPS
address with **Copy address** and **Open Hatch** actions. Visitors must be on
your tailnet and still sign in to Hatch.

**Disconnect** stops the private listener. It preserves the enrolled device
identity for the next connection. The enabled preference and identity survive
Platform restarts; an enabled connection starts again automatically. To revoke
the device entirely, remove it from the Tailscale admin console after
disconnecting it in Hatch.

Your original Hatch address stays available. `APP_URL` remains the canonical
origin used by the Agent and external integrations; connecting Tailscale adds
an access address without changing that deployment contract. App and Workflow
links copied from the browser use the address you are currently visiting.

## Installation

The Docker image includes a small Go executable using the official
[`tsnet` library](https://tailscale.com/docs/features/tsnet). No extra Compose
service, Tailscale client on the host, TUN device, elevated container capability,
or inbound port forwarding is required. The feature starts disconnected.

For a source installation, use Go 1.26.6 or newer and run:

```bash
pnpm tailscale:build
```

If your Go installation permits automatic toolchain downloads, use
`GOTOOLCHAIN=auto pnpm tailscale:build`. The executable is written to
`bin/hatch-tailscale`. It is independent of the JavaScript build. Go checks run
with `pnpm tailscale:test`.

The Platform owns the executable's lifecycle. The helper connects to the
Platform's loopback HTTP port. Source production (`pnpm preview` or the built
Node entry point) uses `NITRO_PORT`, then `PORT`, then `3000`, matching Nitro.
Docker sets `PORT=3700`. Development defaults to `3700`, accepts the same port
variables and Vite's `--port` option, and passes the resolved port to the helper.
An occupied development port fails startup instead of silently selecting another.
For example, `PORT=4000 pnpm dev:platform` serves the Platform on port `4000`
and forwards Tailscale traffic to that same local port.

Use `HATCH_TAILSCALE_PORT` only to override the helper's local proxy target;
it does not change the Platform listener. A custom executable location
can be configured with `HATCH_TAILSCALE_BINARY`. The helper sends the local
listener a fixed loopback HTTP Host and preserves the external hostname in
forwarding metadata. Development retains Vite's Host filter without adding a
tailnet hostname or wildcard to its allowlist.

Node identity and certificates live in the private `.tailscale` directory under
`HATCH_DATA_DIR` (the Platform workspace by default). Preserve this directory
with the Platform volume. Do not share it between installations or mount it
into the Agent Runner. The connection preference lives in `platform_config`.
The Runner never starts a Tailscale node.

## Connection boundaries

Connection management owns enrollment, persistent node identity, and listener
lifetime. The HTTP ingress only forwards requests; application routing and
authentication remain in the Platform. The Platform address and independently
enabled App Service addresses share one node identity and private network.

- Only the Platform's HTTP service is proxied; the Runner API and database ports
  are not listeners on the Tailscale node. Funnel is not enabled.
- Only authenticated Hatch users can read or change connection settings.
- Enrollment uses Tailscale's browser login. No auth key is stored in the panel,
  and Platform credentials or ambient Tailscale credentials are not passed to
  the helper process.
- Hatch trusts only the exact HTTPS origin reported by its active helper for
  authentication requests. It never trusts all `*.ts.net` origins or uses
  Tailscale identity headers to bypass Hatch authentication.
- A stopped or unresponsive connection loses its trusted origin. Errors remain
  visible in the panel, where the connection can be retried or disconnected.

## Troubleshooting

The panel distinguishes waiting for sign-in, waiting for device approval,
connection errors, and a ready HTTPS listener. Missing DNS or certificate
settings are retried automatically. If the helper exits, select **Reconnect**.
A missing executable shows installation guidance and disables connection.

If you disconnect while visiting the private address, the panel asks you to
confirm first. Use your original Hatch address to reconnect afterward.

## Independent App addresses

Each deployed App can advertise one private HTTPS Tailscale Service from its
management page under **Access address**. Enter a dedicated service name (for
example, `notes`) to use `https://notes.<tailnet>.ts.net/`.
The service name is independent of the mutable App slug; deployments, rollbacks
and slug changes keep the address. Names must be unique within this Hatch
installation and should identify the same App across every host of that Service.

Hatch only configures and advertises the Service on its existing embedded node.
It does not create Service definitions, approve hosts, change grants, or request
Tailscale API/OAuth credentials. In the Tailscale admin console:

1. Assign an existing ACL tag to the Hatch node. Tagged nodes are required for
   Service hosting; console tagging does not require another sign-in.
2. Define `svc:notes` with exactly `tcp:443` as its endpoint.
3. Approve this host, or merge an automatic approval rule into your existing
   policy. Grant the intended clients access separately:

```json
{
  "autoApprovers": {
    "services": { "svc:notes": ["tag:hatch"] }
  },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["svc:notes"], "ip": ["443"] }
  ]
}
```

Use a tag already assigned to Hatch and adjust the audience to your requirements;
this is an example to merge, not a replacement policy. Automatic approval does
not create the Service definition. Enabling an address can happen before these
steps; Hatch shows **Waiting for Tailscale configuration or approval** until the
control plane authorizes hosting. **Ready** means this host has authorization
and an HTTPS certificate, not that every client has access. Clients on Tailscale
1.94 or later discover Services without requiring `accept-routes`; older Linux
clients require route acceptance.

Opening the address serves the App directly at `/`, without the platform shell.
The original platform App URL continues working. Existing same-origin
`/api/app/<id>/...` SDK addresses work on the independent origin too; only that
App's runtime endpoints are admitted. Platform management, Server Functions,
other Apps and source/artifact downloads are not exposed through this ingress.
Apps with a hard-coded platform origin need to use relative runtime URLs to take
advantage of this address; Hatch does not rewrite third-party source code.

Hatch authentication is preserved. The first visit returns through the platform
sign-in page and then back to the original App path, query and fragment. An
existing platform session avoids another password prompt. Each App receives a
host-only, encrypted HttpOnly cookie bound to its App ID, origin and binding
revision; it does not receive the platform session token. One-time browser-bound
handoff codes expire in 60 seconds. Platform logout/session expiry revokes App
access. RPC/Data retain their authentication, and Webhook/KV retain their declared
secret/signature requirements; Tailscale identity headers do not replace them.

Stopping an address withdraws this node's advertisement. Archiving, deleting or
losing a supported live deployment also withdraws it; enabled bindings recover
on restart or restoration. Tailscale Service definitions and other hosts are
left under the administrator's control. Existing deployments require no rebuild
or compatibility version upgrade. The additive database migration creates empty
binding and short-lived handoff tables; no App data is backfilled.
