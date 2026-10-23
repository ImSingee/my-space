import { Host } from '@expo/ui';
import { Button, HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import {
  buttonStyle,
  contentShape,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { hatchPalette as c } from './theme';
import type { ResourceRowProps } from './resource-row.types';

// Size the label, not just its Host/Button: the entire card must be tappable.
export function ResourceRow({
  title,
  detail,
  kind,
  onPress,
}: ResourceRowProps) {
  return (
    <View
      style={{
        borderBottomWidth: 0.5,
        borderColor: c.border,
        backgroundColor: c.card,
      }}
    >
      <Host
        colorScheme="light"
        seedColor={c.accentText}
        matchContents={{ vertical: true }}
        ignoreSafeArea="all"
      >
        <Button onPress={onPress} modifiers={[buttonStyle('plain')]}>
          <HStack
            spacing={12}
            alignment="center"
            modifiers={[
              padding({ vertical: 14, horizontal: 0 }),
              frame({
                minHeight: 64,
                maxWidth: Infinity,
                alignment: 'leading',
              }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Image
              systemName={
                (
                  {
                    app: 'square.grid.2x2',
                    conversation: 'bubble.left.and.bubble.right',
                    workflow: 'arrow.triangle.branch',
                    dashboard: 'rectangle.3.group',
                    settings: 'slider.horizontal.3',
                  } as const
                )[kind]
              }
              modifiers={[
                font({ textStyle: 'title2' }),
                foregroundStyle(c.muted),
                frame({ width: 32 }),
              ]}
            />
            <VStack
              alignment="leading"
              spacing={6}
              modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}
            >
              <Text
                modifiers={[
                  font({ textStyle: 'headline' }),
                  foregroundStyle(c.text),
                  lineLimit(),
                ]}
              >
                {title}
              </Text>
              <Text
                modifiers={[
                  font({ textStyle: 'subheadline' }),
                  foregroundStyle(c.muted),
                  lineLimit(),
                ]}
              >
                {detail}
              </Text>
            </VStack>
            <Image
              systemName="chevron.right"
              modifiers={[
                font({ textStyle: 'caption', weight: 'semibold' }),
                foregroundStyle(c.muted),
              ]}
            />
          </HStack>
        </Button>
      </Host>
    </View>
  );
}
