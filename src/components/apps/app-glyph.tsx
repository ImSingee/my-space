import type { CSSProperties } from 'react';
import classes from './app-glyph.module.css';

/**
 * A small rounded monogram tile for an app, giving each app a stable visual
 * identity in lists and the sidebar. The tint is derived deterministically from
 * a stable seed (the app id) so it never shifts when an app is renamed, and it
 * is drawn from a curated, muted palette that sits inside the warm theme.
 */
const TINTS = ['ember', 'amber', 'rose', 'teal', 'blue', 'green'] as const;

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

export function AppGlyph({
  name,
  seed,
  size = 'md',
}: {
  name: string;
  /** Stable identifier for the tint; defaults to the name. */
  seed?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const tint = TINTS[hash(seed ?? name) % TINTS.length];
  return (
    <span
      className={classes.glyph}
      data-size={size}
      aria-hidden
      style={
        {
          '--glyph-bg': `var(--mantine-color-${tint}-light)`,
          '--glyph-fg': `var(--mantine-color-${tint}-light-color)`,
        } as CSSProperties
      }
    >
      {initialOf(name)}
    </span>
  );
}
