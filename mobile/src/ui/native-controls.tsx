import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Button, IconButton } from './button';
import { Glyph } from './glyph';
import type {
  AttachmentMenuProps,
  ChoiceProps,
  RefreshMenuProps,
} from './native-controls.types';
import { Text, type } from './text';
import { palette as c, radii } from './theme';

/**
 * A sheet that lists every option. Android alerts keep only three buttons,
 * which would hide most refresh intervals and models. `lead` is an action
 * listed above the options.
 */
function OptionSheet({
  open,
  label,
  value,
  options,
  onChange,
  onClose,
  disabled,
  lead,
}: {
  open: boolean;
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  onClose: () => void;
  disabled?: boolean;
  lead?: { label: string; onPress: () => void; disabled?: boolean };
}) {
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* A modal lays out in its own window: its insets are measured there. */}
      <SafeAreaProvider>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(17, 26, 20, 0.32)',
          }}
        />
        <SafeAreaView
          edges={['left', 'right', 'bottom']}
          pointerEvents="box-none"
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View
            style={{
              maxHeight: '80%',
              margin: 8,
              padding: 8,
              borderRadius: radii.sheet,
              backgroundColor: c.card,
            }}
          >
            {lead ? (
              <Button
                variant="secondary"
                glyph="refresh"
                label={lead.label}
                fullWidth
                disabled={lead.disabled}
                onPress={() => {
                  onClose();
                  lead.onPress();
                }}
              />
            ) : null}
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
                    accessibilityState={{ checked: selected, disabled }}
                    disabled={disabled}
                    onPress={() => {
                      onClose();
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
                onPress={onClose}
              />
            </View>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
  compact = false,
}: ChoiceProps) {
  const [open, setOpen] = useState(false);
  // Becoming unavailable while open closes the sheet; nothing can be chosen.
  if (open && disabled) setOpen(false);
  return (
    // Takes what its row leaves; a compact chip keeps one line and cuts it
    // off, so the row's other actions always stay on screen.
    <View style={{ flexGrow: 1, flexShrink: 1, alignItems: 'flex-start' }}>
      <Button
        variant="secondary"
        size={compact ? 'small' : 'regular'}
        singleLine={compact}
        label={(() => {
          const chosen = options.find((option) => option.value === value);
          return chosen?.short ?? chosen?.label ?? label;
        })()}
        disabled={disabled}
        onPress={() => setOpen(true)}
      />
      <OptionSheet
        open={open}
        label={label}
        value={value}
        options={options}
        onChange={onChange}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

/** Refresh now and auto refresh, from one button. */
export function RefreshMenu({
  label,
  interval,
  intervalLabel,
  options,
  onRefresh,
  onInterval,
  disabled,
  intervalDisabled,
}: RefreshMenuProps) {
  const [open, setOpen] = useState(false);
  const auto = interval !== '0';
  return (
    <>
      {auto && intervalLabel ? (
        <Button
          variant="secondary"
          size="small"
          glyph="refresh"
          label={intervalLabel}
          accessibilityHint={`${label}, auto refresh ${intervalLabel}`}
          onPress={() => setOpen(true)}
        />
      ) : (
        <IconButton
          label={label}
          glyph="refresh"
          onPress={() => setOpen(true)}
        />
      )}
      <OptionSheet
        open={open}
        label="Auto refresh"
        value={interval}
        options={options}
        onChange={onInterval}
        onClose={() => setOpen(false)}
        disabled={intervalDisabled}
        lead={{ label: 'Refresh now', onPress: onRefresh, disabled }}
      />
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
