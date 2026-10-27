import type { GlyphName } from './glyph.types';

export type ChoiceProps = {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  glyph?: GlyphName;
};
export type AttachmentMenuProps = {
  disabled: boolean;
  onChoose: (kind: 'photo' | 'file') => void;
};
export type DetailProps = { title: string; text?: string; error?: boolean };
