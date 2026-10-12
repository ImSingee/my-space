import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { authClient } from '~auth/client';
import { accountSessionsQueryOptions } from '~queries/account-sessions';

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(8, 'Use at least 8 characters')
      .max(128, 'Use no more than 128 characters'),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export function ChangePasswordPanel() {
  const modalId = useId();

  useEffect(() => () => modals.close(modalId), [modalId]);

  const open = () => {
    modals.open({
      modalId,
      title: 'Change password',
      centered: true,
      children: (
        <ChangePasswordForm
          onClose={() => modals.close(modalId)}
          onPendingChange={(pending) =>
            modals.updateModal({
              modalId,
              closeOnClickOutside: !pending,
              closeOnEscape: !pending,
              withCloseButton: !pending,
            })
          }
        />
      ),
    });
  };

  return (
    <Stack gap="md" align="flex-start">
      <Stack gap={2}>
        <Text fw={600}>Password</Text>
        <Text size="sm" c="dimmed">
          Update the password you use to sign in.
        </Text>
      </Stack>
      <Button type="button" onClick={open}>
        Change password
      </Button>
    </Stack>
  );
}

function ChangePasswordForm({
  onClose,
  onPendingChange,
}: {
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const submitting = useRef(false);
  const form = useForm({
    initialValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    validate: (values) => {
      const result = passwordSchema.safeParse(values);
      if (result.success) return {};
      return Object.fromEntries(
        result.error.issues.map((issue) => [issue.path[0], issue.message]),
      );
    },
  });
  const queryClient = useQueryClient();
  const change = useMutation({
    meta: { errorToast: false },
    networkMode: 'always',
    retry: false,
    gcTime: 0,
    // Keep passwords and the returned session token out of the mutation cache.
    mutationFn: async () => {
      const { currentPassword, newPassword } = form.getValues();
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error)
        throw new Error(
          result.error.message ??
            'Could not change your password. Please try again.',
        );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: accountSessionsQueryOptions.queryKey,
      });
      form.reset();
      toast.success('Password changed');
      onClose();
    },
    onSettled: () => {
      submitting.current = false;
      onPendingChange(false);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        form.onSubmit(() => {
          if (submitting.current) return;
          submitting.current = true;
          onPendingChange(true);
          change.mutate();
        })(event);
      }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Other devices will be signed out. You will stay signed in here.
        </Text>
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          disabled={change.isPending}
          {...form.getInputProps('currentPassword')}
        />
        <PasswordInput
          label="New password"
          description="Use 8–128 characters."
          autoComplete="new-password"
          disabled={change.isPending}
          {...form.getInputProps('newPassword')}
        />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          disabled={change.isPending}
          {...form.getInputProps('confirmPassword')}
        />
        {change.error && (
          <Alert color="red" title="Password could not be changed" role="alert">
            {change.error.message}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button
            type="button"
            variant="default"
            disabled={change.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" loading={change.isPending}>
            Change password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
