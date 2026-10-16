import { Host, TextInput } from '@expo/ui';
import {
  accessibilityLabel,
  lineLimit,
  textFieldStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useFieldState } from './use-field-state';
import { useImperativeHandle, type Ref } from 'react';

export type NativeFieldRef = { getText: () => string };

export function NativeField({
  ref,
  label,
  value,
  onChange,
  placeholder,
  unavailable,
  multiline,
  maxLength,
}: {
  ref?: Ref<NativeFieldRef>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  unavailable?: boolean;
  multiline?: boolean;
  maxLength?: number;
}) {
  const binding = useFieldState(value, onChange);
  // Native state can advance before its asynchronous onChangeText reaches JS.
  // Submission reads this authoritative snapshot, not the last React event.
  useImperativeHandle(ref, () => ({ getText: () => binding.value.get() }), [
    binding.value,
  ]);
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
