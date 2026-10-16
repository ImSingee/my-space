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
      color={danger ? '#c00' : undefined}
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
      <Text style={{ flex: 1 }}>{label}</Text>
      <Switch
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
      <Button title={title} onPress={() => setExpanded(!expanded)} />
      {expanded ? <Text selectable>{text}</Text> : null}
    </View>
  );
}
