import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, IconButton } from './button';
import { Glyph } from './glyph';
import type { AttachmentMenuProps, ChoiceProps } from './native-controls.types';
import { Text, type } from './text';
import { palette as c, radii } from './theme';

/**
 * A sheet that lists every option. Android alerts keep only three buttons,
 * which would hide most refresh intervals and models.
 */
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceProps) {
  const [open, setOpen] = useState(false);
  // Becoming unavailable while open closes the sheet; nothing can be chosen.
  if (open && disabled) setOpen(false);
  const insets = useSafeAreaInsets();
  const close = () => setOpen(false);
  return (
    <>
      <Button
        variant="secondary"
        label={options.find((option) => option.value === value)?.label ?? label}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={close}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={close}
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(17, 26, 20, 0.32)',
            }}
          />
          <View
            style={{
              maxHeight: '80%',
              marginHorizontal: 8,
              marginBottom: insets.bottom + 8,
              padding: 8,
              borderRadius: radii.sheet,
              backgroundColor: c.card,
            }}
          >
            <Text
              accessibilityRole="header"
              style={[
                type.meta,
                { paddingHorizontal: 12, paddingVertical: 10 },
              ]}
            >
              {label}
            </Text>
            <ScrollView>
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    disabled={disabled}
                    onPress={() => {
                      close();
                      if (!disabled && !selected) onChange(option.value);
                    }}
                    style={({ pressed }) => ({
                      minHeight: 48,
                      paddingHorizontal: 12,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      borderRadius: 14,
                      backgroundColor: pressed ? c.limeSoft : 'transparent',
                    })}
                  >
                    <Text style={[type.body, { flex: 1 }]}>{option.label}</Text>
                    {selected ? (
                      <Glyph name="check" size={16} color={c.moss} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={{ paddingTop: 8 }}>
              <Button
                label="Cancel"
                variant="quiet"
                fullWidth
                onPress={close}
              />
            </View>
          </View>
        </View>
      </Modal>
    </>
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
