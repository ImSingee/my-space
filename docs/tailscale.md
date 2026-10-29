# Tailscale access

Open **Settings → Tailscale** to connect Hatch to your private Tailscale network.
Enter a device name, choose **Interactive sign-in**, and select **Connect Tailscale**. A connection window opens
and automatically takes you to Tailscale authorization when needed. If the
device is already authorized, the waiting window closes automatically. The
panel keeps updating while you authorize and, if required, approve the device
in your Tailscale admin console. If your browser blocks the window or you close
it, use **Continue authorization** to resume. **Cancel connection** stops a
pending connection.

Alternatively, choose **Auth key**, paste a Tailscale auth key, and connect.
This does not open an authorization window. Hatch clears the input after
submission and does not save the key. If sign-in fails, enter a valid key and
select **Reconnect**, or switch to interactive sign-in. Device approval may
still be required by your tailnet policy.

Auth keys enroll a device that needs authentication; they do not replace an
already enrolled identity or switch its tailnet. Restarts and reconnects reuse
the private device state without the enrollment key. Prefer a non-ephemeral
auth key for a persistent installation. Key-based sign-in still requires the
DNS and HTTPS settings below.

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

## Passkeys

Passkeys registered at the original address can also be used at the active
Tailscale address, and passkeys registered through Tailscale work at the original
address. Both use the hostname of `APP_URL` as their stable WebAuthn RP ID.
Existing passkeys do not need to be registered again.

Hatch publishes `/.well-known/webauthn` without requiring sign-in. Its related
origins include `APP_URL` and the exact HTTPS origin of the connected Tailscale
node. Disconnecting or replacing the node updates this declaration immediately;
the response is not cached. Better Auth's shared trusted-origin checks remain
enabled, and signed WebAuthn responses must match the requesting browser origin.
Hatch does not require the browser origin to equal `APP_URL` for passkeys.

Cross-domain use requires a browser supporting WebAuthn Related Origin Requests.
The browser must be able to fetch `https://<APP_URL hostname>/.well-known/webauthn`
with a valid HTTPS certificate, on the default HTTPS port, even while visiting
the Tailscale address. If `APP_URL` uses another port, proxy this declaration on
port 443 too. IP addresses and insecure HTTP domains cannot be used for passkeys;
HTTP localhost remains available for development. A canonical IP address cannot
provide the shared RP ID, even when the Tailscale entrance uses HTTPS.
Browsers without Related Origin Requests support can still use passkeys at the
original address and password sign-in at the Tailscale address.

## CLI and mobile sign-in

`hatch auth login --url https://<node>.<tailnet>.ts.net` works against the
connected Tailscale address. A device sign-in started there opens its approval
page on that same address, so approve it in a browser session for the
Tailscale address. Sign-ins started at `APP_URL` still approve at `APP_URL`.
Hatch only chooses the Tailscale address when the request's host is the exact
origin of the active node; any other host, or a disconnected node, falls back
to `APP_URL`. The CLI keeps refusing approval pages on a different origin.

## Installation

The Docker image includes a small Go executable using the official
[`tsnet` library](https://tailscale.com/docs/features/tsnet). No extra Compose
service, Tailscale client on the host, TUN device, elevated container capability,
or inbound port forwarding is required. The feature starts disconnected.

For a source installation, use Go 1.27.1 or newer and run:

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
can be configured with `HATCH_TAILSCALE_BINARY`. For Vite development, add the
assigned node hostname to Vite's allowed hosts before testing through that
hostname; production Nitro does not use Vite's development host filter.

Node identity and certificates live in the private `.tailscale` directory under
`HATCH_DATA_DIR` (the Platform workspace by default). Preserve this directory
with the Platform volume. Do not share it between installations or mount it
into the Agent Runner. The connection preference lives in `platform_config`.
The Runner never starts a Tailscale node.

## Connection boundaries

Connection management owns enrollment, persistent node identity, and listener
lifetime. The HTTP ingress only forwards requests; application routing and
authentication remain in the Platform. This release exposes one Platform
address. Per-App domains and Tailscale Services are not configured.

- Only the Platform's HTTP service is proxied; the Runner API and database ports
  are not listeners on the Tailscale node. Funnel is not enabled.
- Only authenticated Hatch users can read or change connection settings.
- Enrollment supports interactive browser sign-in or an explicitly supplied
  auth key. Auth keys are sent through the helper's private stdin pipe, never
  saved in platform configuration, returned in status, or passed as process
  arguments or environment variables. Platform credentials and ambient
  Tailscale credentials are not passed to the helper process.
- Hatch trusts only the exact HTTPS origin reported by its active helper for
  authentication requests. It never trusts all `*.ts.net` origins or uses
  Tailscale identity headers to bypass Hatch authentication.
- A stopped or unresponsive connection loses its trusted origin. Errors remain
  visible in the panel, where the connection can be retried or disconnected.

## Troubleshooting

The panel distinguishes waiting for sign-in, waiting for device approval,
preparing HTTPS, connection errors, and a ready HTTPS listener. After enrollment,
first-time certificate preparation can take a few minutes. Hatch shows a waiting
message and keeps retrying even if you leave Settings. After five minutes of
unsuccessful certificate preparation, it shows troubleshooting guidance while
continuing to retry. Missing DNS settings, certificate rate limits, and HTTPS
listener failures show an actionable warning instead of the waiting message.
Missing DNS or certificate settings are retried automatically. If the helper
exits, select **Reconnect**.
The panel lists MagicDNS and HTTPS certificates separately as **Enabled**,
**Not enabled**, or **Unknown**. Only missing settings need to be enabled.
The **Open Tailscale DNS settings** button helps with missing settings or delayed
certificate preparation. Normal preparation, provider rate limits, and listener
failures do not suggest changing DNS settings.
An enabled HTTPS setting does not mean the certificate or listener is ready;
certificate or network failures are reported separately. Unknown settings are
retried without assuming they are disabled.
When the certificate provider supplies a retry time, Hatch keeps the rate-limit
warning visible, waits until that time before requesting another certificate,
and shows it in Settings. Reconnecting
does not bypass the provider's limit. The preparation phase and retry time are
structured helper diagnostics; helpers without them retain the generic status
display.
A missing executable shows installation guidance and disables connection.

If you disconnect while visiting the private address, the panel asks you to
confirm first. Use your original Hatch address to reconnect afterward.
