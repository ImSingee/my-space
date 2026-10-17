import { Host } from '@expo/ui';
import { hatchPalette as c, hatchRadii } from './theme';
import {
  Button,
  DisclosureGroup,
  Menu,
  Picker,
  Text,
  Toggle,
} from '@expo/ui/swift-ui';
import {
  buttonStyle,
  contentShape,
  shapes,
  multilineTextAlignment,
  buttonBorderShape,
  tint,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  labelStyle,
  accessibilityLabel,
  pickerStyle,
  tag,
  textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
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
  fullWidth,
}: ActionProps) {
  return (
    <Host
      colorScheme="light"
      seedColor={c.accentText}
      matchContents={fullWidth ? { vertical: true } : true}
      ignoreSafeArea="all"
      style={{
        minHeight: 44,
        flexShrink: 1,
        ...(fullWidth ? { width: '100%' } : {}),
      }}
    >
      <Button
        onPress={onPress}
        role={danger ? 'destructive' : 'default'}
        modifiers={[
          buttonStyle(secondary ? 'borderless' : 'borderedProminent'),
          buttonBorderShape('roundedRectangle', hatchRadii.card),
          tint(danger ? c.danger : secondary ? c.accentText : c.accent),
          ...(!danger
            ? [foregroundStyle(secondary ? c.accentText : c.text)]
            : []),
          font({ textStyle: 'body', weight: 'semibold' }),
          controlSize(compact ? 'regular' : 'large'),
          disabled(Boolean(unavailable)),
        ]}
      >
        <Text
          modifiers={[
            font({ textStyle: 'body', weight: 'semibold' }),
            multilineTextAlignment('center'),
            lineLimit(),
            frame({
              minHeight: 44,
              ...(fullWidth ? { maxWidth: Infinity } : {}),
            }),
            contentShape(shapes.rectangle()),
          ]}
        >
          {label}
        </Text>
      </Button>
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
      colorScheme="light"
      seedColor={c.accentText}
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
    <Host
      colorScheme="light"
      seedColor={c.accentText}
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
    >
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
      colorScheme="light"
      seedColor={c.accentText}
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={{ minHeight: 44 }}
    >
      <Menu
        label="Attach"
        systemImage="paperclip"
        modifiers={[
          disabled(unavailable),
          labelStyle('iconOnly'),
          accessibilityLabel('Attach'),
          frame({ minWidth: 44, minHeight: 44 }),
        ]}
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
    <Host
      colorScheme="light"
      seedColor={c.accentText}
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
    >
      <DisclosureGroup
        label={title}
        isExpanded={expanded}
        onIsExpandedChange={setExpanded}
      >
        <Text
          modifiers={[
            font({ textStyle: 'caption', design: 'monospaced' }),
            foregroundStyle(error ? c.danger : c.muted),
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
