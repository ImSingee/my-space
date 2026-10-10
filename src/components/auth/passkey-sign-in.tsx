import { Button, Divider, Stack } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PasskeyAuthentication } from '~auth/passkey-authentication';
import {
  browserSupportsPasskeyAutofill,
  browserSupportsPasskeys,
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
  const completing = useRef(false);
  const authentication = useRef<PasskeyAuthentication | null>(null);
  const supported = browserSupportsPasskeys(appOrigin);

  const completeSignIn = useCallback(async () => {
    if (completing.current) return;
    completing.current = true;

    try {
      toast.success('Welcome back');
      await onSuccess();
    } catch {
      completing.current = false;
      toast.error('Signed in, but the next page could not be opened.');
    }
  }, [onSuccess]);

  useEffect(() => {
    if (!supported) return;

    let active = true;
    const flow = new PasskeyAuthentication(completeSignIn, (error) => {
      toast.error(passkeyErrorMessage(error, 'Passkey sign-in failed.'));
    });
    authentication.current = flow;
    void (async () => {
      if (!(await browserSupportsPasskeyAutofill(appOrigin)) || !active) return;
      flow.enableAutofill();
    })();

    const refresh = () => {
      if (document.visibilityState === 'visible') flow.refreshAutofill();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      active = false;
      flow.dispose();
      if (authentication.current === flow) authentication.current = null;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [appOrigin, completeSignIn, supported]);

  if (!supported) return null;

  const signIn = async () => {
    setLoading(true);
    try {
      await authentication.current?.signIn();
    } catch {
      toast.error('Passkey sign-in failed. Please try again.');
    } finally {
      setLoading(false);
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
        Sign in with a passkey
      </Button>
      <Divider label="or use your password" labelPosition="center" />
    </Stack>
  );
}
