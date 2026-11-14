import type { GlyphName } from './glyph.types';

export type ChoiceProps = {
  label: string;
  value: string;
  /** `short` names the chosen option on the control; the menu shows `label`. */
  options: { label: string; value: string; short?: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  glyph?: GlyphName;
  /** Hugs a one-line label instead of taking the row's free width. */
  compact?: boolean;
};
export type AttachmentMenuProps = {
  disabled: boolean;
  onChoose: (kind: 'photo' | 'file') => void;
};
export type DetailProps = { title: string; text?: string; error?: boolean };
export type RefreshMenuProps = {
  /** What a refresh refreshes, e.g. "Refresh dashboard". */
  label: string;
  /** Current auto-refresh value; '0' is off. */
  interval: string;
  /** Short name of the current interval, shown on the control when on. */
  intervalLabel?: string;
  options: { label: string; value: string }[];
  onRefresh: () => void;
  onInterval: (value: string) => void;
  /** Refresh now is unavailable. */
  disabled?: boolean;
  /** Changing the interval is unavailable, e.g. while one is saving. */
  intervalDisabled?: boolean;
};
