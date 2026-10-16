# Mobile verification

## Generic v1 API follow-up on macOS — 2026-10-16 UTC

Backend Draft #189 (`feat/hatch-mobile-api`, `b150ca77c52679c6a97ac2d9fd75317b95c2b00c`)
exposes interactive resources through the existing public API. Mobile Draft #184
is stacked above it; source `a944ca38b5c131380ad2431f172d776bddb74110` merges that
backend without rewriting history. Latest master `b0ff5051` is preserved,
including #187's all-model image support. This follow-up changes JavaScript and
server routing; it uses the signed, freshly prebuilt/compiled SDK58 native binary
from the preceding section. The concluding documentation-only commit does not
change the tested runtime.

The native client now uses the existing plain-array/object App endpoints and
generic `/api/v1/agent/models`, `/api/v1/agent/sessions`, App handoff issuance and
`/api/v1/auth/handoffs/consume`. The Draft-only `/api/mobile/v1` router and duplicate
App DTOs are removed. Existing Agent run, answer, SSE, cancel and binary upload
transports stay in place. See [the full API inventory, authentication, reuse
analysis and rollout](platform-api.md#interactive-agent-and-app-resources).

The production backend was rebuilt and the two owned disposable local platforms
restarted. The dedicated iPhone 17 Pro/iOS27 Simulator was cold-started through
Computer Use and the acceptance skill's AXe driver. Fresh runtime evidence shows
200 responses for App/model/session reads; new session creation; a 200 handoff
issuance followed by form POST 303 and an authenticated App page. An actually
expired database ticket produced the native 401/retry screen; requesting a fresh
ticket recovered. The old namespace returns 404.

A new QA Alternate conversation streamed through the real Runner. Cold-launching
while it awaited a question restored the question from the generic session
snapshot. Blue then Other cleared the option; the actual accepted payload held
only Orange for the single-choice answer and Read/Walk for the multiple-choice
answer. Pausing the owned Runner displayed saved/waiting without another submit
control; continuing it produced the matching tool output and completed reply.
The system Photos picker supplied a stock fixture image to QA Alternate; the
model receipt confirmed `imageCount: 1` and the native reply completed. The old
unsupported-image-model observation below is historical and no longer applies
after #187. Native sign-out, normal matching-code browser approval, and returning
to the native App list also passed on the new paths, with no password entry.

Final local root/mobile types, formatting/lint, 35 mobile tests, production
backend build, 13 interactive/auth/security tests and 10 browser device-approval
tests passed. The final full backend suite had 1,410 passes, 26 skips and five
5-second host timeouts in `src/agent/runtime.test.ts`; all 27 tests in that file
passed serially with a 30-second ceiling. Exact-head remote CI and CLI builds
for both layers are linked in their PR descriptions. Earlier SDK58 layout,
keyboard, attachment and recovery media retain their original source provenance;
they are not relabeled as fresh execution of the generic API revision.

## SDK 58 follow-up on macOS — 2026-10-16 UTC

Delivery is stacked: `master` → `feat/hatch-mobile-api` (server support) →
`feat/hatch-expo-mobile` (mobile client, existing Draft PR #184). Native execution
used SDK58 source `64898cac4b401fbe6b4d157f96d25944427a06a6`; subsequent split
commits preserve the runtime implementation and record the final layer SHAs in
the acceptance. Server HTTP tests no longer import mobile source; the native
POST-source assertions live with the mobile core tests. Each layer has its own
CI, including explicit pull-request triggers for the stacked base.

This follow-up upgrades the mobile project from `664ab2f` to Expo 58.0.12,
React 19.3.0, React Native 0.88.0, Router 58.0.21, `@expo/ui` 58.0.19 and
WebView 14.0.1 using Expo's compatibility metadata. The SDK 57 record below
remains historical; its media is not described as SDK 58 execution.

The ignored iOS project was regenerated with the new scene lifecycle and the
private-networking plugin, then compiled through Xcode 27 beta 5 (`27A5237l`).
The Expo wrapper exited without producing a new binary, so the generated
`Hatch.xcworkspace`/`Hatch` scheme was built directly with `xcodebuild`.
The final Simulator build used normal ad-hoc signing (`CODE_SIGN_IDENTITY=-`)
and was installed on both dedicated iPhone 17 Pro/iOS 27 (402×874 points) and
iPhone SE 3/iOS 26 (375×667 points). An earlier unsigned diagnostic build could
not read its saved Keychain session; the final signed build restored the
existing session without resetting authentication data. No Apple signing
credential, physical-device, Android, distribution, or Expo Go test is claimed.

Actual Computer Use and Simulator interactions found and repaired Router 58
layout changes: the transparent default header covered Home's segmented control
and short conversation history. These screens and the App WebView now use the
supported opaque system header. Home assigns safe-area ownership to React Native
so its SwiftUI form does not intercept segmented-control touches. Left/right
safe areas avoid double-counting the top navigation inset. Both Home segments,
short histories, WebView, compact keyboard and large text were retested.

Fresh SDK 58 evidence covers saved-session/cold restore, invalid-origin rejection,
browser cancellation, normal A/B device authorization with matched codes and
explicit approval, return to the native app, separate App lists, sign-out and
cleared drafts on returning to A. Existing fixture credentials were used only
in the normal local login forms; password entry was excluded from recordings.
The test App used the real one-use POST handoff and prompted before an external
link. No production data or external message delivery was used.

The real Runner and deterministic local provider exercised native model choice,
streaming, single-choice/Other in both directions, multiple answers, accepted
answer waiting while the Runner was paused, and tool output. The answer request
contained only `Orange` for the single-choice question, returned HTTP 200 once,
and resumed after the Runner continued. Photos and Files were selected through
the system pickers. An unsupported image model retained the draft; selecting a
supported model sent the photo and 64-byte file. Navigation retained the draft,
successful sending cleared it, and logout/source switching removed it.

Client offline/background recovery, Runner TCP loss/reconnect, and cold history
were exercised. The recovered server transcript contained all 200 unique tokens
from `token-000` through `token-199`. Stop addressed its actual run ID and returned
200; a real injected provider 503 offered manual Retry, which completed after
restoration. Compact default and large Dynamic Type, light/dark mode, native
model menus, visible software keyboard, and a return-key/newline plus continued
input were inspected. The model received `SDK58 compact\nQ` unchanged.

Expo doctor passed 20/20; frozen-lockfile installation, iOS bundle export,
root/mobile types, formatting/lint and all 33 mobile tests passed. The full local
unit run had 1,442 passes, 26 skips and two timeouts while native builds and host
disconnections competed for resources; both affected files passed a serial
rerun (38 tests). Exact-SHA remote CI is reported separately on the Draft PR.

This SDK upgrade adds no schema, compatibility/protocol version, telemetry or
product feature. Earlier boundary-fault probes are retained with their original
provenance only where the underlying pure client/server behavior is unchanged;
they are not fresh SDK 58 runtime evidence. See the same acceptance history:
<https://app.lobehub.com/acceptance/f2e97780-8df7-4fe9-b081-f921932239fe>.

## Native follow-up on macOS — 2026-10-15/16

The earlier Linux-only record below is historical. The development client was
subsequently prebuilt, compiled, installed, and exercised on dedicated iOS
Simulators on the user's Mac. This was not Expo Go or a physical-device test.
The remote branch was checked at `8b06b278dc68f54e116f9958e74bae02a0ebf25b`;
the follow-up includes the local fixes listed below and the native UI changes.

Acceptance and original screenshots/recordings:
<https://app.lobehub.com/acceptance/f2e97780-8df7-4fe9-b081-f921932239fe>.
Round 1 retains its original failure/blocked findings; the follow-up records
repairs and the additional native interactions without rewriting that history.

Environment: Xcode 27 beta 5 (`27A5237l`), Node 26.11.0, pnpm 12.11.2,
Expo 57.0.28, React Native 0.86.3, and `@expo/ui` 57.0.25. The new native module
and ephemeral-networking plugin were applied through iOS prebuild and an actual
native compile/install. The compile completed with zero errors and four toolchain
warnings. Dedicated iPhone 17 Pro/iOS 27 and iPhone SE (3rd generation)/iOS 26
Simulators covered 402×874 and 375×667 points. No physical iPhone, signing,
TestFlight, production data, payment, or real message delivery was used.

Two isolated local platforms used separate PostgreSQL databases, fixture
accounts, normal browser device authorization, a deployed test App, and a real
Runner connected to a deterministic local model. Fault injection was limited to
those test services. Passwords, cookies, device tokens, and private fixture
scripts are excluded from published evidence.

Observed and repaired defects:

- Single-choice option plus Other produced two answers and HTTP 409. Choosing
  Other now clears the option; choosing an option clears Other. Both directions,
  multiple choices, free text, one accepted answer while waiting, and Runner
  resume were exercised through the native UI and checked against real requests.
- Draft edits could lose characters through asynchronous query updates. Local
  draft state and native text bindings preserve rapid edits/caret; native return
  and rapid software-keyboard entry arrived at the model unchanged.
- Newly created empty conversations were absent from the list until refresh.
  Creation now invalidates the list immediately.
- Small Safari login inputs triggered viewport zoom and clipped approval.
  Coarse-pointer inputs use at least 16px; actual approval was retested.
- A lease-aborted run displayed Retry although the server accepts failed-error
  turns only. Retry now follows the server's stop-reason contract.
- A Stop alert left open until completion could cancel `/runs/null`. The alert
  now captures its original run ID; stopping both an active run and an already
  completed run sent the correct ID and preserved the transcript.
- Large Dynamic Type made the model picker's bridged height overlap the composer.
  A native Menu with an inline Picker keeps its trigger on one line and exposes
  complete, checked options in the menu. Light/dark mode, large text, and the
  visible software keyboard were retested on the compact Simulator.

The native-first follow-up uses grouped forms/list rows, system buttons, menus,
pickers, switches, text fields, and tool disclosures through `@expo/ui`. System
navigation, browser, alerts, Photos, and Files remain native. Business transcripts,
streaming content, image previews, status messages, and WebViews retain their
necessary layouts. See `mobile/AGENTS.md` and the mobile README for the rule and
platform exceptions. Android remains untested.

Additional native evidence covers browser return/cold restore, A/B source and
account isolation, draft navigation, authenticated WebView handoff, tool details,
model selection, text/photo/file delivery, stop/retry, background/SSE/cold replay,
Runner reconnect, attachment limits/retry, online/offline sign-out, and revoked
handoff/session behavior. A held old upload was cancelled by navigation and
sign-out; a new login completed before the old upload returned 401. The new
session remained usable, and the old draft created zero attachments, messages,
or runs. A cache probe found no tested bearer-token matches in the inspected
cache files; it is bounded evidence, not a universal absence claim.

VoiceOver focus/labels were inspected; a full spoken VoiceOver journey and
physical-device, Android, and distribution acceptance remain unverified.
Programmatic checks supplement the native evidence: root/mobile types, formatter
and lint, 33 mobile tests, 1,444 unit tests (26 skipped), frozen-lockfile install,
and iOS Metro/Hermes export passed in this macOS environment. Exact execution
records and tested revision provenance are attached to the acceptance round.

### Historical first-version verification

### Scope and completion criteria

Starting point: `master` at `1837bc991c241be8ecebe7f213ac9e6837820888`.
Implementation date: 2026-10-14. The deliverable is a reviewable Expo development
client and matching backward-compatible server endpoints. Native installation,
physical-device acceptance, and distribution are separate remaining steps.

The first vertical slice covers instance browser authorization → native App list
→ authenticated generated-App WebView → Agent conversation → foreground replay.
The implementation reuses existing run, attachment, model, and session behavior.
It does not refactor the whole platform or move server code into the native graph.

### Verified in the Linux workspace

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

### Broader checks and limits

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

### Required device acceptance before distribution

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

### Compatibility and release order

No database schema migration, historical data migration, App/Workflow package
migration, or compatibility/protocol version bump is required. The session-store
extraction keeps browser server-function behavior and transaction snapshots.
Deploy the backend first, install the development client second, and complete
the device checks before any distribution. Backend rollback disables the new
mobile endpoints while retaining prior browser/CLI behavior.

### Version sources checked

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
