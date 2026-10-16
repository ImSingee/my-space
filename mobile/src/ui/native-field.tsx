import { Host, TextInput } from '@expo/ui';
import {
  accessibilityLabel,
  lineLimit,
  textFieldStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useFieldState } from './use-field-state';

export function NativeField({
  label,
  value,
  onChange,
  placeholder,
  unavailable,
  multiline,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  unavailable?: boolean;
  multiline?: boolean;
  maxLength?: number;
}) {
  const binding = useFieldState(value, onChange);
  return (
    <Host
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={{ minHeight: 44 }}
    >
      <TextInput
        {...binding}
        placeholder={placeholder}
        editable={!unavailable}
        multiline={multiline}
        maxLength={maxLength}
        modifiers={[
          accessibilityLabel(label),
          textFieldStyle('roundedBorder'),
          ...(multiline ? [lineLimit({ min: 1, max: 5 })] : []),
        ]}
      />
    </Host>
  );
}
