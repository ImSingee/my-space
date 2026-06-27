# Product

## Register

product

## Users

People who want their own small software — trackers, dashboards, internal tools,
usage monitors — without writing or operating code. They range from
non-technical to technical, and they treat Hatch as a personal hub: a place to
describe an app in plain language, watch the Agent build and deploy it, then live
with it day to day in the sidebar and on dashboards.

## Product Purpose

Hatch is an AI-native personal app platform. You describe an app in plain
language; the Agent scaffolds it, builds it, deploys it, and pins it into your
sidebar and dashboards. Success is the gap between "I wish I had a tool for this"
and "it's running and on my dashboard" shrinking to a short conversation. The
product's job is to make that loop feel calm, trustworthy, and craftsmanlike —
never like a noisy developer console.

## Brand Personality

Warm, calm, precise. The voice is a quietly capable maker: confident without
shouting, friendly without being cute. Editorial warmth (a serif display voice
over clean sans) signals care and taste; restraint signals trust. Emotional
goal: the user feels the product is on their side and knows what it's doing.

Reference: **claude.ai** — the same warm, literary calm, generous whitespace,
gentle borders, and color used sparingly and on purpose.

## Anti-references

- Generic SaaS dashboards: cold corporate blue, gradient-soaked hero metrics,
  busy chrome.
- The "AI cream / sand / parchment" body background — the saturated 2026 AI
  tell. Hatch carries warmth through accent + type over a true-white body, never
  a tinted-beige canvas.
- "Ghost cards": a 1px border plus a soft wide drop shadow as decoration.
- Neon / techy dark dashboards trying to look "powerful".
- Over-rounded, bubbly, toy-like UI (32px+ radii on cards).

## Design Principles

1. **Warmth through accent and type, not tinted backgrounds.** The body stays a
   true white; warmth lives in the terracotta accent, stone ink, and serif
   display.
2. **Calm by default, color on purpose.** Neutral surfaces carry the work;
   the ember accent marks the one thing that matters on a screen.
3. **Editorial hierarchy.** Serif display for large titles, a clean sans for
   everything else; size and weight do the work before color does.
4. **Flat, honest surfaces.** Hairline borders over heavy shadows; no nested
   cards; affordances revealed on intent (hover/focus), quiet at rest.
5. **Quiet, intentional motion.** Short ease-out transitions on things that
   respond to the pointer; always a reduced-motion alternative.

## Accessibility & Inclusion

- Target WCAG AA: body text ≥ 4.5:1, large text ≥ 3:1; placeholders meet body
  contrast, not muted-gray.
- Visible keyboard focus ring (the ember theme enables `focusRing: 'auto'`).
- Every animation has a `prefers-reduced-motion` fallback.
- Full light and dark parity; never rely on color alone to convey state.
