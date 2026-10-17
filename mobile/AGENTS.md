# Mobile UI conventions

Match Hatch's Ember visual system in `../DESIGN.md`: white canvas, warm stone
ink and borders, orange accent, lightly warm panels, editorial display headings,
and flat 12–16 point cards. The platform is light-only; native screens follow
that policy too. `src/ui/theme.ts` projects its tokens without importing the
Mantine/web runtime. Use the system serif fallback for large display headings
and native Dynamic Type for controls and body text.

Prefer `@expo/ui` for interaction: SwiftUI/Jetpack Compose buttons, list items,
fields, pickers, switches, menus, and disclosure controls. Theme their supported
tint, typography, and shape properties rather than substituting painted controls.
Native-first does not mean using a default system Form for every page. React
Native owns Hatch's page composition, branded connection screen, resource cards,
conversation transcript, composer, questions, and attachment previews. Keep each
SwiftUI/Compose subtree inside its Host. Do not put React Native content directly
inside native controls without the supported bridge.

Keep Expo Router's native stack, system browser authorization, native alerts,
and Photos/Files pickers. Preserve native disabled, selected, and destructive
states. Keep touch targets at least 44 points, let text wrap/scale, and avoid
competing safe-area or keyboard insets. Use platform files for platform-specific
APIs; keep the other platform buildable without claiming unperformed acceptance.

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
