import {
  Button,
  Paper,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { Brand } from '~components/app-shell/brand';
import { fetchSession } from '~server/auth';
import classes from './login.module.css';

/**
 * Resolve the post-login destination. Only same-origin absolute paths are
 * honored so a crafted `?redirect=` can't bounce a freshly authenticated user
 * to another origin (`//evil.com`, `https://evil.com`, `/\evil.com`).
 */
function safeRedirect(target: string | undefined): string {
  if (target && /^\/(?![/\\])/.test(target)) return target;
  return '/dashboard';
}

export const Route = createFileRoute('/login')({
  validateSearch: (search): { redirect?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: async ({ search }) => {
    const session = await fetchSession();
    if (session) {
      throw redirect({ href: safeRedirect(search.redirect) });
    }
  },
  component: LoginPage,
});

type Mode = 'signin' | 'signup';

function LoginPage() {
  const router = useRouter();
  const { redirect: redirectTo } = Route.useSearch();
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
      await router.navigate({ href: safeRedirect(redirectTo) });
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
          <Stack gap="md" align="center">
            <Brand size="lg" withWordmark={false} />
            <Stack gap={6} align="center">
              <Title order={2} ta="center">
                {mode === 'signin' ? 'Welcome back' : 'Create your account'}
              </Title>
              <Text c="dimmed" size="sm" ta="center" maw={300}>
                Spin up your own apps just by talking to AI.
              </Text>
            </Stack>
          </Stack>

          <Paper withBorder radius="lg" p="xl" className={classes.card}>
            <Stack gap="lg">
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
                <Stack gap="md">
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
                  <Button
                    type="submit"
                    loading={loading}
                    mt="xs"
                    fullWidth
                    size="md"
                  >
                    {mode === 'signin' ? 'Sign in' : 'Create account'}
                  </Button>
                </Stack>
              </form>
            </Stack>
          </Paper>

          <Text c="dimmed" size="xs" ta="center">
            {mode === 'signin'
              ? 'New here? Switch to Create account above.'
              : 'Already have an account? Switch to Sign in above.'}
          </Text>
        </Stack>
      </div>
    </div>
  );
}
