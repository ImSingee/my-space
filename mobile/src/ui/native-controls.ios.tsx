import { Host } from '@expo/ui';
import { Button, HStack, Image, Menu, Picker, Text } from '@expo/ui/swift-ui';
import {
  accessibilityElement,
  accessibilityLabel,
  background,
  contentShape,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  multilineTextAlignment,
  padding,
  pickerStyle,
  shapes,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { glyphs } from './glyph.types';
import { palette as c } from './theme';
import type { AttachmentMenuProps, ChoiceProps } from './native-controls.types';

// System menus keep native selection, VoiceOver and dismissal behavior; the
// trigger is drawn as a Field Guide chip.
export function Choice({
  label,
  value,
  options,
  onChange,
  disabled: unavailable,
  glyph,
}: ChoiceProps) {
  const current = options.find((option) => option.value === value)?.label;
  // Menu labels report their ideal width; cap them to the width RN assigns.
  const [width, setWidth] = useState<number>();
  return (
    // RN owns the width; the chip hugs its label and wraps instead of
    // overflowing at large Dynamic Type sizes.
    <Host
      colorScheme="light"
      seedColor={c.moss}
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      style={{
        minHeight: 44,
        flexGrow: 1,
        flexShrink: 1,
        opacity: unavailable ? 0.5 : 1,
      }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Menu
        label={
          <HStack
            spacing={7}
            modifiers={[
              padding({ horizontal: 14, vertical: 10 }),
              frame({ minHeight: 44 }),
              background(c.paper, shapes.capsule()),
              contentShape(shapes.capsule()),
              frame({ maxWidth: width, alignment: 'leading' }),
              accessibilityElement('combine'),
              accessibilityLabel(`${label}: ${current ?? 'none'}`),
            ]}
          >
            {glyph ? (
              <Image
                systemName={glyphs[glyph]}
                modifiers={[
                  font({ textStyle: 'footnote', weight: 'semibold' }),
                  foregroundStyle(c.moss),
                ]}
              />
            ) : null}
            <Text
              modifiers={[
                font({ textStyle: 'subheadline', weight: 'semibold' }),
                foregroundStyle(c.ink),
                lineLimit(3),
                multilineTextAlignment('leading'),
                fixedSize({ horizontal: false, vertical: true }),
                layoutPriority(1),
              ]}
            >
              {current ?? label}
            </Text>
            <Image
              systemName="chevron.up.chevron.down"
              modifiers={[
                font({ textStyle: 'caption2', weight: 'bold' }),
                foregroundStyle(c.inkSoft),
              ]}
            />
          </HStack>
        }
        modifiers={[
          frame({ maxWidth: Infinity, alignment: 'leading' }),
          disabled(Boolean(unavailable)),
          accessibilityLabel(`${label}: ${current ?? 'none'}`),
        ]}
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

export function AttachmentMenu({
  disabled: unavailable,
  onChoose,
}: AttachmentMenuProps) {
  return (
    <Host
      colorScheme="light"
      seedColor={c.moss}
      matchContents
      ignoreSafeArea="all"
      style={{ minHeight: 44, opacity: unavailable ? 0.45 : 1 }}
    >
      <Menu
        label={
          <Image
            systemName="paperclip"
            modifiers={[
              font({ textStyle: 'body', weight: 'semibold' }),
              foregroundStyle(c.ink),
              frame({ width: 44, height: 44 }),
              background(c.sunken, shapes.circle()),
              contentShape(shapes.circle()),
              accessibilityLabel('Attach'),
            ]}
          />
        }
        modifiers={[disabled(unavailable), accessibilityLabel('Attach')]}
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
