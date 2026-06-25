import {
  Button,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { Brand } from '~components/app-shell/brand';
import { fetchSession } from '~server/auth';
import classes from './login.module.css';

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await fetchSession();
    if (session) {
      throw redirect({ to: '/dashboard' });
    }
  },
  component: LoginPage,
});

type Mode = 'signin' | 'signup';

function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signin');
  const [loading, setLoading] = useState(false);

  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      password: (v) =>
        v.length >= 8 ? null : 'Password must be at least 8 characters',
      name: (v) =>
        mode === 'signup' && v.trim().length === 0 ? 'Enter your name' : null,
    },
  });

  const submit = form.onSubmit(async (values) => {
    setLoading(true);
    try {
      const result =
        mode === 'signin'
          ? await authClient.signIn.email({
              email: values.email,
              password: values.password,
            })
          : await authClient.signUp.email({
              email: values.email,
              password: values.password,
              name: values.name.trim(),
            });

      if (result.error) {
        toast.error(result.error.message ?? 'Authentication failed');
        return;
      }
      toast.success(mode === 'signin' ? 'Welcome back' : 'Account created');
      await router.navigate({ to: '/dashboard' });
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  });

  return (
    <div className={classes.root}>
      <div className={classes.panel}>
        <Stack gap="xl">
          <Stack gap={6} align="center">
            <Brand size="lg" />
            <Text c="dimmed" size="sm" ta="center">
              Spin up your own apps just by talking to AI.
            </Text>
          </Stack>

          <Paper withBorder radius="lg" p="xl" shadow="sm">
            <Stack gap="md">
              <SegmentedControl
                fullWidth
                value={mode}
                onChange={(v) => setMode(v as Mode)}
                data={[
                  { label: 'Sign in', value: 'signin' },
                  { label: 'Create account', value: 'signup' },
                ]}
              />
              <form onSubmit={submit}>
                <Stack gap="sm">
                  {mode === 'signup' ? (
                    <TextInput
                      label="Name"
                      placeholder="Your name"
                      {...form.getInputProps('name')}
                    />
                  ) : null}
                  <TextInput
                    label="Email"
                    placeholder="you@example.com"
                    {...form.getInputProps('email')}
                  />
                  <PasswordInput
                    label="Password"
                    placeholder="••••••••"
                    {...form.getInputProps('password')}
                  />
                  <Button type="submit" loading={loading} mt="xs" fullWidth>
                    {mode === 'signin' ? 'Sign in' : 'Create account'}
                  </Button>
                </Stack>
              </form>
            </Stack>
          </Paper>
        </Stack>
      </div>
    </div>
  );
}
