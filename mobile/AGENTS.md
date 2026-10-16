# Mobile UI conventions

Prefer `@expo/ui` and the operating system's native appearance before building a
custom control. Use SwiftUI/Jetpack Compose forms, buttons, pickers, switches,
menus, and disclosure controls where available. Keep Expo Router's native stack,
system browser authorization, system alerts, and the system Photos/Files pickers.
Do not paint replacements for controls already provided by those APIs.

Use system semantic colors, system typography, Dynamic Type, and native disabled,
selected, and destructive states. Keep a SwiftUI/Compose subtree inside one Host;
React Native owns layout outside that boundary. Avoid competing safe-area or
keyboard inset handling. Use platform files when an API is platform-specific;
keep the other platform buildable without claiming unperformed acceptance.

Custom layout is appropriate for conversation transcripts, streamed tool content,
attachment previews, and generated Apps' WebViews. Document other exceptions and
the missing native capability in README.md before adding one. A business layout
exception does not justify painting its buttons, menus, or input controls.

Keep authentication, query identity, cancellation, draft ownership, and duplicate
submission guards independent from presentation. Native text bindings must not
echo delayed JavaScript edits over newer native text or reset selection.

Install dependencies with `pnpm exec expo install` from mobile. Adding or changing
native modules requires prebuild, native compilation, and installation; Metro
reload is insufficient. Verify real iOS Simulator interactions with screenshots
and recordings, including keyboard, small screens, safe areas, light/dark mode,
Dynamic Type, and affected login/chat/attachment flows. State the exact runtime;
do not describe a Simulator as a physical device.
