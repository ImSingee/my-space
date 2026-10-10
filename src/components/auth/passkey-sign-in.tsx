import { Button, Divider, Stack } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const completing = useRef(false);
  const hasSession = useRef(false);
  const mounted = useRef(true);
  const supported = browserSupportsPasskeys(appOrigin);

  const completeSignIn = useCallback(async () => {
    if (!mounted.current || completing.current) return;
    completing.current = true;
    hasSession.current = true;
    setAuthenticated(true);
    setLoading(true);
    try {
      await onSuccess();
      toast.success('Welcome back');
    } catch {
      if (mounted.current) {
        toast.error(
          'Signed in, but the next page could not be opened. Click Continue to try again.',
        );
      }
    } finally {
      completing.current = false;
      if (mounted.current) setLoading(pending.current);
    }
  }, [onSuccess]);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    if (supported) {
      void (async () => {
        try {
          const available =
            await PublicKeyCredential.isConditionalMediationAvailable?.();
          if (!available || !active || hasSession.current || pending.current)
            return;

          const result = await authClient.signIn.passkey({ autoFill: true });
          if (active && !result.error && !hasSession.current) {
            await completeSignIn();
          }
        } catch {
          // Autofill is optional; button and password sign-in remain available.
        }
      })();
    }
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [completeSignIn, supported]);

  if (!supported) return null;

  const signIn = async () => {
    if (pending.current || completing.current) return;
    pending.current = true;
    setLoading(true);
    try {
      if (!hasSession.current) {
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
        if (hasSession.current) return;
      }

      // Retry only navigation if the SDK already established the session.
      await completeSignIn();
    } catch {
      if (mounted.current) {
        toast.error('Passkey sign-in failed. Please try again.');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(completing.current);
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
