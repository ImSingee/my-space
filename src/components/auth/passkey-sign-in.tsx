import { Button, Divider, Stack } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import {
  browserSupportsPasskeys,
  isPasskeyCancellation,
  passkeyErrorMessage,
} from '~auth/passkey-browser';

export function PasskeySignIn({
  appOrigin,
  onSuccess,
}: {
  appOrigin: string;
  onSuccess: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const supported = browserSupportsPasskeys(appOrigin);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!supported) return null;

  const signIn = async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    try {
      if (!authenticated) {
        const result = await authClient.signIn.passkey();
        if (!mounted.current) return;
        if (result.error) {
          if (!isPasskeyCancellation(result.error)) {
            toast.error(
              passkeyErrorMessage(result.error, 'Passkey sign-in failed.'),
            );
          }
          return;
        }
        setAuthenticated(true);
      }

      // Retry only navigation if the SDK already established the session.
      try {
        await onSuccess();
        toast.success('Welcome back');
      } catch {
        if (mounted.current) {
          toast.error(
            'Signed in, but the next page could not be opened. Click Continue to try again.',
          );
        }
      }
    } catch {
      if (mounted.current) {
        toast.error('Passkey sign-in failed. Please try again.');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  };

  return (
    <Stack gap="md">
      <Button
        type="button"
        variant="default"
        size="md"
        fullWidth
        loading={loading}
        leftSection={<IconKey size={18} stroke={1.7} />}
        onClick={signIn}
      >
        {authenticated ? 'Continue' : 'Sign in with a passkey'}
      </Button>
      <Divider label="or use your password" labelPosition="center" />
    </Stack>
  );
}
