import { Host, TextInput } from '@expo/ui';
import {
  accessibilityLabel,
  lineLimit,
  textFieldStyle,
  foregroundStyle,
  font,
} from '@expo/ui/swift-ui/modifiers';
import { hatchPalette as c, hatchRadii } from './theme';
import type { TextInputProps, TextInputRef } from '@expo/ui';
import { Pressable } from 'react-native';
import { useFieldState } from './use-field-state';
import { useImperativeHandle, useRef, type Ref } from 'react';

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
  keyboardType,
  onSubmitEditing,
}: {
  ref?: Ref<NativeFieldRef>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  unavailable?: boolean;
  multiline?: boolean;
  maxLength?: number;
  keyboardType?: TextInputProps['keyboardType'];
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
}) {
  const binding = useFieldState(value, onChange);
  const input = useRef<TextInputRef>(null);
  // Native state can advance before its asynchronous onChangeText reaches JS.
  // Submission reads this authoritative snapshot, not the last React event.
  useImperativeHandle(ref, () => ({ getText: () => binding.value.get() }), [
    binding.value,
  ]);
  return (
    <Pressable
      accessible={false}
      focusable={false}
      disabled={unavailable}
      onPress={() => input.current?.focus()}
      style={{
        minHeight: 44,
        padding: 12,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: hatchRadii.card,
        backgroundColor: c.card,
      }}
    >
      <Host
        colorScheme="light"
        seedColor={c.accentText}
        matchContents={{ vertical: true }}
        ignoreSafeArea="all"
        style={{ minHeight: 24 }}
      >
        <TextInput
          ref={input}
          {...binding}
          placeholder={placeholder}
          editable={!unavailable}
          multiline={multiline}
          maxLength={maxLength}
          keyboardType={keyboardType}
          autoCapitalize={keyboardType === 'url' ? 'none' : 'sentences'}
          autoCorrect={keyboardType !== 'url'}
          autoComplete={keyboardType === 'url' ? 'url' : undefined}
          returnKeyType={keyboardType === 'url' ? 'go' : undefined}
          onSubmitEditing={onSubmitEditing}
          modifiers={[
            accessibilityLabel(label),
            textFieldStyle('plain'),
            foregroundStyle(c.text),
            font({ textStyle: 'body' }),
            ...(multiline ? [lineLimit({ min: 1, max: 5 })] : []),
          ]}
        />
      </Host>
    </Pressable>
  );
}
