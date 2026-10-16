# Hatch Mobile

An iPhone-first Expo development build for a self-hosted Hatch instance. The app
library, conversation list, model picker, chat, attachments, questions, and run
controls prefer `@expo/ui` native components and Expo Router's native stack. Generated Apps
open in a separate authenticated WebView.

## Run it

Requirements:

- Node.js 26 (recommended) and the repository's pnpm 12.11.2. Expo also
  supports the compatible even-numbered Node 22/24 releases.
- The Hatch platform **from this branch**, with its normal database, at least one
  enabled provider/model, and a connected Agent Runner. Existing server setup is
  described in the [root README](../README.md).
- An HTTPS origin reachable from the phone. Enter the canonical `APP_URL` without
  a path, query, or fragment. Browser approval must stay on that exact origin.
- For a local iOS development build: macOS, Xcode 26.4+, an iOS 16.4+ simulator or
  device, and the usual Xcode signing setup for physical devices. SDK 58 generates the
  scene lifecycle required by Xcode 27/iOS 27 automatically.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir mobile ios
```

This generates the ignored native project, builds the development client, and
starts Metro. For later sessions with that development build installed:

```sh
pnpm mobile:start
```

Enter the instance origin, continue in the system browser, verify the displayed
code, approve **Hatch Mobile**, and return to the app. This grants full account
access, matching Hatch's existing single-tenant model. Mobile does not accept
API keys or Runner/Workflow credentials as a user login.

Development-only loopback HTTP (`localhost`, `127.0.0.1`, `[::1]`) is accepted for
simulator testing. LAN HTTP is intentionally rejected. A physical phone's
`localhost` is the phone itself; use a trusted HTTPS address. Never bypass a TLS
warning or place a bearer token in a URL.

This is a development-build project, not an Expo Go-only app. `eas.json` also
contains development, simulator, and preview profiles. Running an EAS build,
creating signing credentials, uploading to TestFlight, or publishing a release
are separate actions; none were performed for this delivery. Replace the sample
bundle identifier with your own before distribution.

## SDK 58 compatibility

Expo is pinned to `58.0.12`; the official installer aligns React `19.3.0`,
React Native `0.88.0`, Router `58.0.21`, `@expo/ui` `58.0.19`, WebView `14.0.1`,
and their native companions. See the [SDK 58 release notes](https://expo.dev/changelog/sdk-58)
and [upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/).
The lockfile records exact resolutions. Release-age exclusions are limited to
the exact new Expo package versions selected by the installer; other supply-chain
checks remain enabled.

Regenerate the ignored iOS/Android projects when upgrading SDKs and rebuild the
development client. SDK 58 generates `SceneDelegate.swift`; the old
`expo-build-properties` scene-support opt-in is no longer needed. The app still
applies its private-networking plugin before React starts. `expo-status-bar` and
`expo-web-browser` now have explicit config plugins.

The mobile project uses the React Native strict TypeScript API, including native
instance ref types, without the legacy opt-out. Its base tsconfig includes the
`.json` extension so the test transformer can resolve SDK 58's package exports.
The chat list uses automatic content-inset adjustment. Home, chat, and WebView
screens explicitly use Router's supported opaque system header, keeping short
histories and segmented controls below navigation. Home and WebView apply only
left/right safe areas; Home lets React Native own its Host safe area to prevent
the native form from intercepting segmented-control touches. Native controls
and layout are verified separately from a successful bundle export.

## What is included

- Native Apps and conversations lists, pull-to-refresh, loading/error/empty states.
- New conversations, configured model selection, history, selectable answer text,
  expandable reasoning/tool requests and output, and links to generated Apps.
- Up to six combined attachments per message: files up to 25 MiB each, plus JPEG,
  PNG, WebP, and GIF images. Photos use model image input. Oversized images are
  rejected with guidance rather than silently truncated. Repeated file uploads
  reuse the same attachment ID.
- Agent questions with single/multiple options and free-text answers; explicit
  stop and failed-turn retry controls. Ambiguous run creation is reconciled before
  any user retry, never automatically repeated.
- Foreground SSE streaming and backoff reconnection from the last rendered event
  sequence. Backgrounding closes the stream without stopping the server's run.
  A cold-open replays from zero, avoiding a stored cursor without its transcript.
- Per-instance SecureStore sessions, browser device authorization, cancellation,
  expiry/401 recovery, sign-out, and native-to-WebView session handoff.

## Security and architecture

`src/core/` contains shared-Connect message projections, storage/transport interfaces,
URL validation, login orchestration, and SSE state. Only `core/native.ts` imports
SecureStore, Expo Crypto, WebBrowser, and Expo's streaming `fetch`.

Tokens use a SHA-256-origin storage key and Keychain
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Requests bind to one canonical instance, use
`Authorization: Bearer`, omit cookies, and reject redirects before following.
Late 401 responses and cancelled sign-ins cannot delete a newer stored token.
On iOS, the private-networking config plugin installs an ephemeral Expo Fetch
session with no HTTP cache, cookie store, or credential store before React starts.
It also clears the app's legacy URLCache files on launch. API requests explicitly
disable caching; TanStack Query keeps list and conversation data in memory only.
Re-run `pnpm exec expo prebuild --platform ios` from `mobile/` and rebuild the
native client after changing this plugin; a Metro reload is not sufficient.
The UI serializes instance transitions, clears query state, and remounts native
navigation/WebViews when the identity changes. Removing a screen also aborts its
unfinished uploads and mutations so an old operation cannot pick up a newly
issued credential for the same instance. A run already accepted by the server
continues independently.

The WebView receives only a random, one-use, at-most-60-second ticket in a form
POST body. The server binds it to the original session, exact trusted instance,
and fixed deployed-App target. Atomic consumption sets a host-only HttpOnly
cookie for the **same server session** and redirects to the App's embed route.
There is no bearer URL, injected credential, or JavaScript credential bridge.
Native sign-out or server-side revocation invalidates the WebView session too.

WebViews are incognito, do not share browser/native cookie stores, reject file
access and mixed content, and restrict navigation. External HTTPS links require
a user choice before opening the browser. Android's WebView cookie behavior is
platform-global rather than iOS's isolated nonpersistent store; this first pass
is iPhone-first and does not claim Android session-isolation acceptance.

The client uses generated `@hatch/platform-api` descriptors with Connect Web
unary JSON transport at `/api/rpc`. App list/detail use `AppService/ListApps`
and `GetApp`; model catalog and session list/create/detail use `AgentService`;
`AppService/CreateAppHandoff` issues the ticket. The browser consumes it with
form `POST /api/auth/handoffs/consume` and follows its 303 redirect. There is no
mobile API namespace, REST alias or fallback to undocumented Server Functions.
The shared proto is the wire contract. A small UI projection restores nullable
fields and transcript JSON from Protobuf optional fields and Value messages.
Metro resolves the shared package's ESM `.js` specifiers to its checked-in
TypeScript sources without modifying generated files or third-party resolution.

Connect requests retain the same per-origin SecureStore, explicit Bearer,
no-cookie/no-cache/no-redirect, cancellation and stale-401 safeguards. PublicError
details map logical errors (including size limits) to existing native recovery;
raw server errors are never displayed and mutations are never automatically
retried. An unavailable model-catalog RPC reports an unsupported backend.
Existing Agent run, SSE, answer, cancel and attachment transports stay at
`/api/agent/...`, and device/login/logout remain Better Auth HTTP endpoints.
Interactive resources require an ordinary user session; API keys and Run JWTs
cannot acquire conversation or browser sessions. No database migration or
Platform/Runner, App, or Workflow compatibility-version bump is required.

Deploy backend #189 before this client. Previously issued tickets expire within
60 seconds; request a fresh handoff after upgrading. Rollback must pair the
client and backend protocol revisions. See [the API contract](../docs/platform-api.md#interactive-agent-and-app-resources).

## Native-first UI

Follow [the mobile development conventions](AGENTS.md). Connection and settings
use native grouped forms; the library uses native list rows and a segmented
control. Buttons, model/single-answer pickers, multiple-answer switches, attachment
menus, text fields, and tool disclosures use system controls. iOS uses SwiftUI
through `@expo/ui`; Expo Router supplies the native navigation stack. System
semantic colors and typography follow light/dark appearance and Dynamic Type.

React Native still lays out the conversation transcript, streamed content, status
messages, and image previews because these are Hatch-specific content, rather
than standard form controls. Its KeyboardAvoidingView owns the composer's keyboard
inset; small embedded native Hosts ignore their own safe areas to avoid applying
it twice. Generated Apps remain authenticated WebViews. Browser approval, alerts,
Photos, and Files keep their existing system APIs. Android uses the corresponding
universal components or system controls; iOS acceptance does not establish Android
layout or session isolation.

Native text fields keep their text binding on the native side. JavaScript updates
external changes (such as selecting a recent instance or clearing a sent draft)
without replaying each delayed edit over newer input or moving its caret.

Re-run prebuild and compile/install the development client after adding `@expo/ui`.
A Metro reload cannot add a native module.

## Checks

```sh
pnpm check:types
pnpm format
pnpm mobile:check
pnpm mobile:test
pnpm mobile:export:ios
pnpm test:unit
pnpm test:browser src/components/cli-auth/device-approval.browser.test.tsx
```

The iOS export verifies Metro and Hermes bundling, not native runtime behavior.
The Connect migration is verified with unit/contract tests, type checks and
builds only; no Simulator or UI acceptance was run for this revision. Earlier
macOS acceptance compiled and installed SDK58 on dedicated iOS 26/27 Simulators
and exercised the old generic-v1 protocol. That evidence remains historical and
does not verify Connect. Physical-device and Android acceptance remain
unverified. See [the verification record](../docs/mobile-verification.md).

## Deliberate first-version limits

- No provider/secret management, dashboard editing, push notifications, share
  extension, background Agent execution, full offline history, or offline outbox.
- Environment-value requests tell you to continue in Hatch web. Secrets are not
  collected in native chat.
- Drafts and selected attachments are in-memory and scoped to each conversation.
  They survive navigating away and foreground pauses, but are cleared on instance
  changes, sign-out, or process termination. Successful sends clear that draft.
- Chat text is selectable native text; full web Markdown/math rendering is not
  replicated. Generated application UIs remain WebViews.
- App downloads, custom URL schemes, and arbitrary in-WebView browsing are not
  implemented. Use Hatch web for these flows.
- No simulator/device screenshot, recording, TestFlight build, or store release
  is claimed. The manual device checks below remain required before distribution.
