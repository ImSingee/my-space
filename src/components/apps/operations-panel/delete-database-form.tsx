import {
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';

export function DeleteDatabaseForm({
  appName,
  managed,
  modalId,
  onDelete,
}: {
  appName: string;
  managed: boolean;
  modalId: string;
  onDelete: (confirmation: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const remove = useMutation({
    mutationFn: () => onDelete(confirmation),
    onSuccess: () => modals.close(modalId),
  });
  const confirmed = confirmation === appName;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed && !remove.isPending) remove.mutate();
      }}
    >
      <Stack gap="sm">
        <Text size="sm">
          {managed
            ? 'This permanently deletes all managed Data Table data for '
            : 'This permanently deletes the database for '}
          <Text span fw={600} style={{ overflowWrap: 'anywhere' }}>
            {appName}
          </Text>
          {managed
            ? ', including every managed table, row, and migration record.'
            : ' and all data stored in it.'}{' '}
          This cannot be undone.
        </Text>
        <Text size="sm" c="dimmed">
          {managed
            ? 'To use Data Tables again, deploy a new release with the capability enabled. The platform will create an empty database and apply its schema.'
            : 'To use a database again, deploy a version with the database capability enabled.'}
        </Text>
        <Stack gap={4}>
          <Group gap={4}>
            <Text size="sm">Type</Text>
            <UnstyledButton
              type="button"
              aria-label={`Fill app name ${appName}`}
              fz="sm"
              fw={600}
              disabled={remove.isPending}
              style={{ overflowWrap: 'anywhere', textDecoration: 'underline' }}
              onClick={() => {
                setConfirmation(appName);
                input.current?.focus();
              }}
            >
              {appName}
            </UnstyledButton>
            <Text size="sm">to confirm</Text>
          </Group>
          <TextInput
            ref={input}
            aria-label={`Type ${appName} to confirm`}
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            disabled={remove.isPending}
            autoComplete="off"
            data-autofocus
          />
        </Stack>
        {remove.isError ? (
          <Text size="sm" c="red" role="alert">
            {remove.error instanceof Error
              ? remove.error.message
              : 'Failed to delete the database.'}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button
            type="button"
            variant="default"
            disabled={remove.isPending}
            onClick={() => modals.close(modalId)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            color="red"
            loading={remove.isPending}
            disabled={!confirmed}
          >
            {managed ? 'Delete Data Table data' : 'Delete database'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
