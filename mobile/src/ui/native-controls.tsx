import { hatchPalette as c } from './theme';
import { useState } from 'react';
import { Alert, Button, Switch, Text, View } from 'react-native';
import type {
  ActionProps,
  AttachmentMenuProps,
  ChoiceProps,
  DetailProps,
} from './native-controls.types';

export function Action({ label, onPress, disabled, danger }: ActionProps) {
  return (
    <Button
      title={label}
      onPress={onPress}
      disabled={disabled}
      color={danger ? c.danger : c.accentText}
    />
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled,
}: ChoiceProps) {
  return (
    <Button
      color={c.accentText}
      title={`${label}: ${options.find((option) => option.value === value)?.label ?? ''}`}
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
export function OptionToggle({
  label,
  selected,
  onChange,
  unavailable,
}: {
  label: string;
  selected: boolean;
  onChange: () => void;
  unavailable: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={{ flex: 1, color: c.text }}>{label}</Text>
      <Switch
        trackColor={{ true: c.accentText }}
        accessibilityLabel={label}
        value={selected}
        onValueChange={onChange}
        disabled={unavailable}
      />
    </View>
  );
}
export function AttachmentMenu({ disabled, onChoose }: AttachmentMenuProps) {
  return (
    <Button
      color={c.accentText}
      title="Attach"
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
export function Details({ title, text }: DetailProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Button
        color={c.accentText}
        title={title}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <Text selectable style={{ color: c.muted }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}
