import { requireNativeView } from 'expo';
import { StyleSheet } from 'react-native';
import type { FoldProbeProps, FoldRect } from './fold-probe.types';

const HatchFold = requireNativeView<{
  style: unknown;
  pointerEvents: 'none';
  onFoldChange: (event: { nativeEvent: { folds: FoldRect[] } }) => void;
}>('HatchFold');

/**
 * Fills its container, behind the content, and reports where the display
 * folds across it in the container's coordinates (`modules/hatch-fold`).
 */
export function FoldProbe({ onFolds }: FoldProbeProps) {
  return (
    <HatchFold
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onFoldChange={(event) => onFolds(event.nativeEvent.folds)}
    />
  );
}
