import { Host, TextInput } from '@expo/ui';
import {
  accessibilityLabel,
  lineLimit,
  textFieldStyle,
  foregroundStyle,
  font,
} from '@expo/ui/swift-ui/modifiers';
import type { TextInputProps, TextInputRef } from '@expo/ui';
import { Pressable, View } from 'react-native';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { IconButton } from './button';
import { Glyph } from './glyph';
import { palette as c, radii } from './theme';
import { useFieldState } from './use-field-state';

export type NativeFieldRef = { getText: () => string };

const chrome = {
  box: {
    backgroundColor: c.card,
    borderColor: c.rule,
    borderWidth: 1,
    borderRadius: radii.tile,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  search: {
    backgroundColor: c.sunken,
    borderColor: c.sunken,
    borderWidth: 1,
    borderRadius: 999,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
  },
  bare: { paddingHorizontal: 4, paddingVertical: 8 },
} as const;

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
  variant = 'box',
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
  variant?: keyof typeof chrome;
}) {
  const binding = useFieldState(value, onChange);
  const input = useRef<TextInputRef>(null);
  // Native state can advance before its asynchronous onChangeText reaches JS.
  // Submission reads this authoritative snapshot, not the last React event.
  useImperativeHandle(ref, () => ({ getText: () => binding.value.get() }), [
    binding.value,
  ]);
  const search = variant === 'search';
  return (
    <Pressable
      accessible={false}
      focusable={false}
      disabled={unavailable}
      onPress={() => input.current?.focus()}
      style={[
        {
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          opacity: unavailable ? 0.6 : 1,
        },
        chrome[variant],
      ]}
    >
      {search ? <Glyph name="search" size={15} color={c.inkSoft} /> : null}
      <Host
        colorScheme="light"
        seedColor={c.moss}
        matchContents={{ vertical: true }}
        ignoreSafeArea="all"
        style={{ minHeight: 24, flex: 1 }}
      >
        <TextInput
          ref={input}
          {...binding}
          placeholder={placeholder}
          placeholderTextColor={c.inkFaint}
          cursorColor={c.moss}
          selectionColor={c.moss}
          editable={!unavailable}
          multiline={multiline}
          maxLength={maxLength}
          keyboardType={keyboardType}
          autoCapitalize={
            keyboardType === 'url' || search ? 'none' : 'sentences'
          }
          autoCorrect={keyboardType !== 'url' && !search}
          autoComplete={keyboardType === 'url' ? 'url' : undefined}
          returnKeyType={
            keyboardType === 'url' ? 'go' : search ? 'search' : undefined
          }
          onSubmitEditing={onSubmitEditing}
          modifiers={[
            accessibilityLabel(label),
            textFieldStyle('plain'),
            foregroundStyle(c.ink),
            font({ textStyle: 'body' }),
            ...(multiline ? [lineLimit({ min: 1, max: 6 })] : []),
          ]}
        />
      </Host>
      {search && value ? (
        <IconButton
          label="Clear search"
          glyph="clear"
          tone="clear"
          size={36}
          onPress={() => onChange('')}
        />
      ) : search ? (
        <View style={{ width: 44, height: 44 }} />
      ) : null}
    </Pressable>
  );
}
