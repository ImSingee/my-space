import {
  Alert,
  Button,
  Group,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { authClient, type Session } from '~auth/client';
import { usersPanelQueryOptions } from '~queries/users';

const nicknameSchema = z.string().trim().min(1, 'Enter a nickname');

export function AccountProfilePanel() {
  const { data, isPending, error, refetch } = authClient.useSession();

  if (isPending) {
    return (
      <Stack gap="md">
        <Skeleton height={24} width={100} />
        <Skeleton height={64} />
      </Stack>
    );
  }
  if (error || !data) {
    return (
      <Alert color="red" title="Profile could not be loaded">
        <Button type="button" variant="subtle" onClick={() => void refetch()}>
          Try again
        </Button>
      </Alert>
    );
  }

  return (
    <ProfileForm key={`${data.user.id}:${data.user.name}`} user={data.user} />
  );
}

function ProfileForm({ user }: { user: Session['user'] }) {
  const qc = useQueryClient();
  const submitting = useRef(false);
  const form = useForm({
    initialValues: { name: user.name },
    validate: {
      name: (value) => {
        const result = nicknameSchema.safeParse(value);
        return result.success ? null : result.error.issues[0].message;
      },
    },
  });
  const save = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    mutationFn: async (name: string) => {
      const result = await authClient.updateUser({ name });
      if (result.error)
        throw new Error(
          result.error.message ??
            'Could not save your nickname. Please try again.',
        );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: usersPanelQueryOptions.queryKey });
      toast.success('Nickname updated');
    },
    onSettled: () => {
      submitting.current = false;
    },
  });

  return (
    <form
      onSubmit={(event) => {
        form.onSubmit(({ name }) => {
          if (submitting.current || name.trim() === user.name) return;
          submitting.current = true;
          save.mutate(nicknameSchema.parse(name));
        })(event);
      }}
    >
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={600}>Profile</Text>
          <Text size="sm" c="dimmed">
            Choose the name displayed for your account.
          </Text>
        </Stack>
        <TextInput
          label="Email"
          value={user.email}
          disabled
          autoComplete="email"
        />
        <TextInput
          label="Nickname"
          autoComplete="nickname"
          disabled={save.isPending}
          {...form.getInputProps('name')}
        />
        {save.error && (
          <Alert color="red" title="Nickname could not be saved" role="alert">
            {save.error.message}
          </Alert>
        )}
        <Group justify="flex-start">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={form.values.name.trim() === user.name}
          >
            Save nickname
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
