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
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { browserSupportsPasskeys } from '~auth/passkey-browser';
import { Brand } from '~components/app-shell/brand';
import { PasskeySignIn } from '~components/auth/passkey-sign-in';
import { hasActiveSession } from '~server/auth';
import { getSignupConfig } from '~server/users';
import { passkeyOriginQueryOptions } from '~queries/passkeys';
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
    const authenticated = await hasActiveSession();
    if (authenticated) {
      throw redirect({ href: safeRedirect(search.redirect) });
    }
  },
  // Whether to offer "Create account" is a runtime platform setting — the
  // server enforces it either way; this only keeps the UI honest.
  loader: async ({ context: { queryClient } }) => {
    const [signup, appOrigin] = await Promise.all([
      getSignupConfig(),
      queryClient.ensureQueryData(passkeyOriginQueryOptions),
    ]);
    return { ...signup, appOrigin };
  },
  component: LoginPage,
});

type Mode = 'signin' | 'signup';

function LoginPage() {
  const router = useRouter();
  const { redirect: redirectTo } = Route.useSearch();
  const { allowSignup, appOrigin } = Route.useLoaderData();
  const [rawMode, setRawMode] = useState<Mode>('signin');
  // When sign-up is closed there is nothing to switch to — pin sign-in even if
  // a signup mode was selected before the config loaded.
  const mode: Mode = allowSignup ? rawMode : 'signin';
  const [passwordLoading, setPasswordLoading] = useState(false);

  const navigateAfterAuthentication = useCallback(async () => {
    await router.navigate({ href: safeRedirect(redirectTo) });
  }, [redirectTo, router]);

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
    setPasswordLoading(true);
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
      await navigateAfterAuthentication();
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setPasswordLoading(false);
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
              {allowSignup && (
                <SegmentedControl
                  fullWidth
                  value={mode}
                  onChange={(v) => setRawMode(v as Mode)}
                  data={[
                    { label: 'Sign in', value: 'signin' },
                    { label: 'Create account', value: 'signup' },
                  ]}
                />
              )}
              {mode === 'signin' ? (
                <PasskeySignIn
                  appOrigin={appOrigin}
                  onSuccess={navigateAfterAuthentication}
                />
              ) : null}
              <form onSubmit={submit}>
                <Stack gap="md">
                  {mode === 'signup' ? (
                    <TextInput
                      label="Name"
                      autoComplete="name"
                      {...form.getInputProps('name')}
                    />
                  ) : null}
                  <TextInput
                    label="Email"
                    autoComplete={
                      mode === 'signin'
                        ? browserSupportsPasskeys(appOrigin)
                          ? 'username webauthn'
                          : 'username'
                        : 'email'
                    }
                    {...form.getInputProps('email')}
                  />
                  <PasswordInput
                    label="Password"
                    autoComplete={
                      mode === 'signin' ? 'current-password' : 'new-password'
                    }
                    {...form.getInputProps('password')}
                  />
                  <Button
                    type="submit"
                    loading={passwordLoading}
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
            {!allowSignup
              ? 'Sign-up is disabled. Ask the owner of this space for access.'
              : mode === 'signin'
                ? 'New here? Switch to Create account above.'
                : 'Already have an account? Switch to Sign in above.'}
          </Text>
        </Stack>
      </div>
    </div>
  );
}
