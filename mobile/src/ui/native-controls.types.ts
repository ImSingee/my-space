export type ActionProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  compact?: boolean;
  fullWidth?: boolean;
};
export type ChoiceProps = {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
};
export type AttachmentMenuProps = {
  disabled: boolean;
  onChoose: (kind: 'photo' | 'file') => void;
};
export type DetailProps = { title: string; text?: string; error?: boolean };
