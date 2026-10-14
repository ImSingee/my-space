# Mobile first-version verification

## Scope and completion criteria

Starting point: `master` at `1837bc991c241be8ecebe7f213ac9e6837820888`.
Implementation date: 2026-10-14. The deliverable is a reviewable Expo development
client and matching backward-compatible server endpoints. Native installation,
physical-device acceptance, and distribution are separate remaining steps.

The first vertical slice covers instance browser authorization → native App list
→ authenticated generated-App WebView → Agent conversation → foreground replay.
The implementation reuses existing run, attachment, model, and session behavior.
It does not refactor the whole platform or move server code into the native graph.

## Verified in the Linux workspace

- A reproducible `pnpm install --frozen-lockfile` using pnpm 12.11.2, with its
  supply-chain checks enabled and no new policy exceptions.
- Root `pnpm check:types`, including the SDK and mobile TypeScript projects.
- Root `pnpm format`, including the final Oxlint pass.
- Hatch SDK, web platform production build, Agent Runner bundle, and CLI bundle.
  The sandbox blocks the `tsx` CLI IPC socket, so its three build scripts were
  executed with the equivalent `node --import tsx` entrypoint; Vite ran normally.
  Existing dependency `use client` and server-function deprecation warnings remain.
- iOS Metro/Hermes production export. This resolves/bundles the actual native
  imports, including Expo fetch, SecureStore, file/photo pickers, Router, and
  react-native-webview. It is not an Xcode native build.
- iOS prebuild with no dependency/native compilation. Generated AppDelegate and
  Info.plist include SDK 57 scene lifecycle support; deployment target is 16.4.
- 29 durable client-core tests: URL/instance boundaries, SecureStore isolation,
  cancelled/expired/slow-down device authorization, cancellation during storage
  and final validation, replacement-credential races, redirects, 401s, sign-out,
  request timeouts, API-version checks, SSE chunk framing/replay/deduplication,
  and abort handling, including idle-heartbeat timeout, stalled native cancellation,
  and preventing old upload sequences from using replacement credentials.
- 51 backend/related regression tests: real Better Auth device sessions with
  isolated PGlite data, safe resource projections/model config, native versus
  browser credentials, origin boundaries, signed WebView cookies, one-use and
  concurrent consumption, expiration/revocation, target/App changes, existing
  Agent session/run/environment behavior, and binary attachment boundaries.

No production account was accessed. Tests use temporary stores, fake transports,
and isolated auth/database fixtures. No production/user password, API key, device token, or provider credential
was generated or used; auth credentials in tests are isolated fixtures.

The final focused regression run covers 80 tests across eight files.

## Broader checks and limits

The first whole-unit-suite run completed with 1,344 passed, 54 failed, and 50
skipped tests (13 failing files and three worker/runtime errors). It was not a
clean suite: the initial environment lacked Deno and Playwright's Chromium,
fixture pnpm subprocesses could not use the default home, and a test worker was
killed while dependencies were installing concurrently. These failures are not
counted as passes or hidden by the focused results above.

Deno 2.9.7, matching the Dockerfile, was subsequently installed. A second
single-worker broad pass still failed runtime/build fixture setup and was stopped
when it stalled. A targeted environment probe then established the remaining
Deno blocker: its npm fetch could not resolve `registry.npmjs.org` inside the
fixture execution boundary. With a writable temporary home and pnpm 12.11.2,
all ten CLI workspace tests passed; the independent Workflow scaffold probe
remained blocked by that DNS failure. The full suite is therefore still not
verified clean. No unrelated runtime source was changed to suppress these tests.

The mobile browser-approval regression test is retained. Downloading the managed
Chromium build produced an incomplete archive; attempting the available system
Chromium was blocked at process/socket setup in this sandbox. Browser assertions
were not executed successfully here. Real-auth HTTP tests cover the device-flow
and cookie boundaries independently.

No Xcode, iOS Simulator, physical iPhone, Apple signing account, or working native
GUI was available. There are no claimed device screenshots or interaction
recordings. Android compilation and cookie behavior are also unverified.

## Required device acceptance before distribution

Use an isolated test Hatch instance and temporary data, not a production account.
Record screenshots for static states and recordings for interaction behavior.

1. Install the development client on iOS 16.4+; test light/dark appearance, large
   text, VoiceOver labels, native back swipe, sheet dismissal, keyboard avoidance,
   safe areas, scroll-to-latest, and reading older messages during streaming.
2. Sign in through the system browser. Check the instance and code, approve Hatch
   Mobile, and return. Also deny, expire, cancel while waiting, and cancel during
   the post-login config request. A cancelled flow must never activate a session.
3. Connect to two distinct test origins. Verify the saved token, query data,
   conversation, and WebView never cross instances. Reject credential URLs,
   paths/query/fragments, off-origin verification links, and API redirects. During
   a multi-file upload, sign out and reconnect to the same origin; the old upload
   sequence must stop without sending the draft using the replacement session.
4. Create a conversation, select an enabled model, send text, attach photos and
   files, retry a failed upload with the same ID, and reject oversize/six-plus
   attachments. Confirm an ambiguous send is reconciled before manually retrying.
5. Answer single-choice, multi-choice, and free-text questions; cancel a run and
   retry a failed turn. Verify a secret/environment request opens the web flow
   without collecting secrets in native chat.
6. Background a streaming run, complete it server-side, and reopen. Toggle the
   network, foreground repeatedly, and terminate/relaunch. Text and tool output
   should neither disappear nor duplicate; server work continues in background.
7. Open a generated App. Confirm one-use handoff, history/navigation, expired
   ticket recovery, external-link confirmation, and revoked-session handling.
   No long-lived token may appear in URLs, WebView JS, logs, or query cache.
8. Sign out online and offline. Local authentication/cache/WebViews must close.
   When server revocation cannot be confirmed, the app must say so and direct the
   user to account sessions. Revoke the server session and verify both native
   requests and existing WebView authentication stop working.

## Compatibility and release order

No database schema migration, historical data migration, App/Workflow package
migration, or compatibility/protocol version bump is required. The session-store
extraction keeps browser server-function behavior and transaction snapshots.
Deploy the backend first, install the development client second, and complete
the device checks before any distribution. Backend rollback disables the new
mobile endpoints while retaining prior browser/CLI behavior.

## Version sources checked

- [Expo SDK reference](https://docs.expo.dev/versions/latest/): SDK 57, RN 0.86,
  React 19.2.3, iOS 16.4+, and Xcode 26.4+.
- [Expo SDK 57 release notes](https://expo.dev/changelog/sdk-57): stable release,
  patched runtime regressions, development-build guidance, and Xcode 27 support.
- [Expo build properties](https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/):
  scene lifecycle opt-in for SDK 57.0.23+.
- The installed `expo@57.0.28/bundledNativeModules.json` sets native dependency
  compatibility ranges. The workspace lockfile pins their resolved versions.

SDK 57.0.28 was selected instead of a same-day patch to preserve pnpm’s default
release-age protection. Native package ranges come from that exact Expo patch;
the lockfile records the compatible, policy-eligible resolutions. The online
`expo install --check` recommends the same-day 57.0.29 patch and its three updated
companions. Offline validation against the installed 57.0.28 metadata passes;
that intentional patch lag is not reported as an online check pass.
