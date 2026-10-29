import { Alert } from 'react-native';
import { Button, IconButton } from './button';
import type { AttachmentMenuProps, ChoiceProps } from './native-controls.types';

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceProps) {
  return (
    <Button
      variant="secondary"
      label={options.find((option) => option.value === value)?.label ?? label}
      disabled={disabled}
      onPress={() =>
        Alert.alert(label, undefined, [
          ...options.map((option) => ({
            text: option.label,
            onPress: () => onChange(option.value),
          })),
          { text: 'Cancel', style: 'cancel' },
        ])
      }
    />
  );
}
export function AttachmentMenu({ disabled, onChoose }: AttachmentMenuProps) {
  return (
    <IconButton
      label="Attach"
      glyph="attach"
      tone="card"
      disabled={disabled}
      onPress={() =>
        Alert.alert('Attach to this message', undefined, [
          { text: 'Photo library', onPress: () => onChoose('photo') },
          { text: 'Choose files', onPress: () => onChoose('file') },
          { text: 'Cancel', style: 'cancel' },
        ])
      }
    />
  );
}
