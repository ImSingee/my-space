import { Button } from '@expo/ui';
export function FormButton({
  label,
  onPress,
  unavailable,
}: {
  label: string;
  onPress: () => void;
  unavailable?: boolean;
  danger?: boolean;
}) {
  return (
    <Button
      label={label}
      onPress={onPress}
      disabled={unavailable}
      variant="text"
    />
  );
}
