# Design

Visual system for Hatch. Warm-editorial product UI built on Mantine v8. Warmth
is carried by accent + type over a true-white body — aligned to claude.ai's calm,
literary feel without adopting its cream canvas.

Source of truth: `src/ui/theme/base-theme.ts` (tokens + component defaults),
`src/ui/ember-theme/` (active theme + `style.css` surface treatment).

## Theme

- Active theme: **ember** (`src/ui/theme/index.ts` → `defaultThemeName`).
- Light + dark, full parity. Color scheme is user-toggled (stored), not
  media-query driven.

## Color

- **Primary (ember / warm orange):** ramp in `base-theme.ts`; fill is shade 6
  `#ea580c` (orange-600) — a confident, warm orange, not brick-red. Hover/active
  darken to shade 7 `#c2410c`. Light tints (`ember-0..3`) carry hovers, badges,
  selection. This is the brand's one saturated voice.
- **Neutrals (stone):** warm-gray ink, borders, and text (`stone` ramp). Dark
  surfaces derive from `secondary`/`stone`.
- **Surfaces:** body = true white (`--mantine-color-body`); panel layer
  `--surface-panel: #faf8f5` (sidebar, chat list) — a whisper of warmth, not
  sand; `--surface-raised: #fff`; `--surface-sunken: #f6f3ee`. Dark equivalents
  in `ember-theme/style.css`.
- **Status:** error=red, success=green, warning=amber, info=blue (Tailwind-style
  ramps). Use sparingly; prefer neutral + one accent.

## Typography

- **Sans (UI + body):** Geist. `fontFamilyMonospace`: Geist Mono.
- **Serif (display):** Fraunces — applied only to large titles (h1/h2 /
  `Title order={1|2}`) via `ember-theme/style.css`; weight 500, letter-spacing
  -0.01em, `text-wrap: balance`. Smaller headings stay sans for label legibility.
- Prose uses `text-wrap: pretty`. Heading scale + line-heights in `base-theme.ts`
  (`headings.sizes`).

## Layout & Spacing

- Spacing scale `4xs`(2) … `4xl`(40) in `base-theme.ts`. Page chrome:
  `src/components/app-shell/page.tsx` (title + description + actions, hairline
  divider) and `sidebar.tsx`.
- Radius: xs6 / sm8 / **md12 (default)** / lg16 / xl24. Cards top out at md/lg;
  never 24px+ on cards.
- Cards: bordered, **flat** (ember `style.css` removes Card/Paper shadow). No
  nested cards.

## Motion

- Easing `--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1)`; durations
  `--transition-fast: 120ms`, `--transition-base: 180ms`.
- Applied to interactive chrome (Button, ActionIcon, NavLink, Chip, CloseButton).
- `prefers-reduced-motion: reduce` collapses transitions/animations globally.

## Components

Mantine, themed in `base-theme.ts`. Conventions: `Anchor` underlined always;
`Select` check on the right; warm theme-aware scrollbars and `::selection`;
pill-shaped sidebar `NavLink`s; tooltips use the primary fill.
