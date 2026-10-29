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
