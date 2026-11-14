# Mobile UI conventions

The native app has its own light visual system, Field Guide, defined in
`src/ui/theme.ts`; it does not follow the web Ember styles. Pale sage paper,
green-black ink, moss for actions and a lime highlighter for live, pinned and
selected states. Rounded system display type (`ui-rounded`) for titles,
system text for body and controls, and uppercase monospaced metadata
(`ui-monospace`) for eyebrows, counts, timestamps and status tags. White
22-point sheets without borders, hairline-divided rows, capsule buttons and
SF Symbols through `Glyph`. Keep every text/surface pair at 4.5:1 or better;
`theme.test.ts` guards the palette. Respect Reduce Motion for the egg loader
and highlighter animations.

React Native owns page composition, buttons, rows, tiles, the transcript,
composer, questions and attachment previews. Use `@expo/ui` where the system
control carries real behavior: text fields, menus/pickers and their native
selection, and SF Symbols. Keep each SwiftUI/Compose subtree inside its Host,
and do not put React Native content inside native controls without the
supported bridge.

Keep Expo Router's native stack, system browser authorization, native alerts,
and Photos/Files pickers. Preserve native disabled, selected, and destructive
states. Keep touch targets at least 44 points, let text wrap/scale, and avoid
competing safe-area or keyboard insets. Use platform files for platform-specific
APIs; keep the other platform buildable without claiming unperformed acceptance.

A scrolling page's main scroll view is its first view (`ScrollScreen`, or
`PageRoot` plus `pageScrollProps`), with the masthead inside the content. Native
tabs only find a first-descendant scroll view, and UIKit then owns the tab bar,
status bar and home indicator insets; never pad for the tab bar by hand. Drive a
`RefreshControl` only from a user pull through `usePullToRefresh`, keep it
mounted, and never bind `refreshing` to query fetch state.

The app resizes while it runs: iPhone Duo moves it between a compact outer
display and a regular-width inner display that can fold, beside another app
or under a vertical bar. Size layouts from their container (`useFoldSplit`,
`Reflow`, `Columns`, `TileGrid` in `src/ui/columns.tsx`), never from the
screen, the device, orientation or a width read once. Where the display folds
is what UIKit reports as division reserved regions, read by the local
`modules/hatch-fold` view behind each container (iOS 27.1 SDK and later;
older SDKs and systems report no fold). Two columns keep their gutter on a
fold that crosses them, grids mirror an even count around it, and without a
fold layouts split evenly and start at the leading edge. Toolbars, tab bars and navigation bars move to a vertical
bar on the side; that bar, like any safe area, may sit on one edge only, so
read each edge's inset from the view that lays out (a nested
`SafeAreaProvider` or `SafeAreaView`), never the window's. Put header actions
in `Stack.Toolbar` items with both an SF Symbol and a title; custom
`headerLeft`/`headerRight` views cannot join the vertical bar. The Agent list
shows the open conversation beside itself when both fit and pushes it on a
compact width; folding or unfolding keeps that conversation open. Production
builds need the iOS 27.1 SDK or later for the full-display Duo layout.

Web surfaces decide every navigation in `src/core/surface-navigation.ts` and
leave the app only through `useExternalLink`. New windows arrive through
`onOpenWindow`; on Fabric `onShouldStartLoadWithRequest` cannot tell them apart.
Every new window opens outside the app: web pages in the system browser, any
other scheme (`mailto:`, `tel:`, `someapp://…`) in the app that owns it. Open
such links with `Linking.openURL` directly; never gate them on `canOpenURL`,
which needs every scheme declared in `LSApplicationQueriesSchemes` (iOS) or
`<queries>` (Android). Keep the sign-in handshake, credential and frame
boundaries covered by its tests.

Deep links name pages by their Hatch web paths (`hatch://app/<slug>#<route>`,
`hatch://agent/<id>`, optional `?instance=<origin>`); phone-only pages live
under `/more`. `src/core/deep-link.ts` owns the grammar and the path table:
a new screen gets a path there and in its tests, never a route of its own in
Expo Router's linking. `app/+native-intent.ts` hands system links to the
inbox and returns null, so Expo Router never routes them;
`useDeepLinkLifecycle` opens them once the saved sign-in is restored, and
notification taps and links followed in web surfaces go through the same
inbox. A link only navigates: it never changes data, starts a run, fills a
draft, signs in or adds an instance. It may switch to another instance this
phone is signed in to, after asking unless it is a decrypted push. Pages
without a screen open in the browser; a web surface leaves those in place.

An App screen's back steps through WebKit's own `canGoBack` before leaving.
While the page has history the screen turns off its native swipe
(`gestureEnabled`), WKWebView's swipe takes over, and `useWebHistoryBack` turns
the back button and Android back into one page step; other removals pass. The
sign-in pages are replaced, never pushed, so they never become history.

Authentication, query identity, cancellation, draft ownership, and duplicate
submission guards are independent of presentation. Native text bindings must
not echo delayed JavaScript edits over newer text or reset selection. Submission
must read current native field snapshots. Preserve the compact composer's
scrolling height bound and the separate accessible attachment/send action row.

Install dependencies with `pnpm exec expo install` from mobile. Adding or changing
native modules requires prebuild, native compilation, and installation; Metro
reload is insufficient. Verify real iOS Simulator interactions with screenshots
and recordings, including keyboard, small screens, safe areas, device appearance,
Dynamic Type, and affected login/chat/attachment flows. State the exact runtime;
web previews and Metro exports are not native runtime acceptance. Do not describe
a Simulator as a physical device.
