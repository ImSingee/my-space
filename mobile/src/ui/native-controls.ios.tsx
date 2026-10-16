import {
  Button,
  DisclosureGroup,
  Host,
  Menu,
  Picker,
  Text,
  Toggle,
} from '@expo/ui/swift-ui';
import {
  buttonStyle,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  lineLimit,
  pickerStyle,
  tag,
  textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { PlatformColor } from 'react-native';
import type {
  ActionProps,
  AttachmentMenuProps,
  ChoiceProps,
  DetailProps,
} from './native-controls.types';

// Each island owns its SwiftUI layout; React Native owns the surrounding screen.
export function Action({
  label,
  onPress,
  disabled: unavailable,
  secondary,
  danger,
  compact,
}: ActionProps) {
  return (
    <Host
      matchContents
      ignoreSafeArea="all"
      style={{ minHeight: compact ? 34 : 44, flexShrink: 1 }}
    >
      <Button
        label={label}
        onPress={onPress}
        role={danger ? 'destructive' : 'default'}
        modifiers={[
          buttonStyle(secondary ? 'borderless' : 'borderedProminent'),
          controlSize(compact ? 'regular' : 'large'),
          disabled(Boolean(unavailable)),
        ]}
      />
    </Host>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled: unavailable,
}: ChoiceProps) {
  return (
    <Host
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={{ minHeight: 44, flex: 1 }}
    >
      <Menu
        label={
          <Text
            modifiers={[lineLimit(1)]}
          >{`${label}: ${options.find((option) => option.value === value)?.label ?? ''}`}</Text>
        }
        modifiers={[disabled(Boolean(unavailable))]}
      >
        <Picker
          label={label}
          selection={value}
          onSelectionChange={onChange}
          modifiers={[pickerStyle('inline')]}
        >
          {options.map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      </Menu>
    </Host>
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
    <Host matchContents={{ vertical: true }} ignoreSafeArea="all">
      <Toggle
        label={label}
        isOn={selected}
        onIsOnChange={onChange}
        modifiers={[disabled(unavailable)]}
      />
    </Host>
  );
}
export function AttachmentMenu({
  disabled: unavailable,
  onChoose,
}: AttachmentMenuProps) {
  return (
    <Host
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={{ minHeight: 44 }}
    >
      <Menu
        label="Attach"
        systemImage="paperclip"
        modifiers={[disabled(unavailable)]}
      >
        <Button
          label="Photo library"
          systemImage="photo"
          onPress={() => onChoose('photo')}
        />
        <Button
          label="Choose files"
          systemImage="doc"
          onPress={() => onChoose('file')}
        />
      </Menu>
    </Host>
  );
}
export function Details({ title, text, error }: DetailProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Host matchContents={{ vertical: true }} ignoreSafeArea="all">
      <DisclosureGroup
        label={title}
        isExpanded={expanded}
        onIsExpandedChange={setExpanded}
      >
        <Text
          modifiers={[
            font({ textStyle: 'caption', design: 'monospaced' }),
            foregroundStyle(
              PlatformColor(error ? 'systemRed' : 'secondaryLabel'),
            ),
            textSelection(true),
            lineLimit(),
          ]}
        >
          {text ?? ''}
        </Text>
      </DisclosureGroup>
    </Host>
  );
}
