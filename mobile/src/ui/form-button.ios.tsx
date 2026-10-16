import { Button } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';

export function FormButton({
  label,
  onPress,
  unavailable,
  danger,
}: {
  label: string;
  onPress: () => void;
  unavailable?: boolean;
  danger?: boolean;
}) {
  // Let Form supply its native row hit target, tint, and destructive appearance.
  return (
    <Button
      label={label}
      onPress={onPress}
      role={danger ? 'destructive' : 'default'}
      modifiers={[disabled(Boolean(unavailable))]}
    />
  );
}
