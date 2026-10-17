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
import { hatchPalette as c, hatchRadii } from './theme';
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
      >
        <Button onPress={onPress} modifiers={[buttonStyle('plain')]}>
          <HStack
            spacing={12}
            alignment="center"
            modifiers={[
              padding({ all: 16 }),
              frame({
                minHeight: 76,
                maxWidth: Infinity,
                alignment: 'leading',
              }),
              contentShape(shapes.rectangle()),
            ]}
          >
            <Image
              systemName={kind === 'app' ? 'square.grid.2x2' : 'bubble.left'}
              modifiers={[
                font({ textStyle: 'title2' }),
                foregroundStyle(c.accentText),
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
