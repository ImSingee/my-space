import { Button, Center, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/**
 * Router-wide error state. Registering it as the default error component gives
 * every route match its own boundary, so a failing page renders here inside
 * the surrounding layout instead of bubbling to the router's global boundary
 * and replacing the whole app shell.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    // Let suspense queries that failed under this boundary refetch on retry.
    queryErrorResetBoundary.reset();
  }, [queryErrorResetBoundary]);

  const retry = async () => {
    setRetrying(true);
    try {
      // Re-runs the loaders and clears route error state once they succeed.
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  };

  return (
    // Fill the viewport below the app header when one is present; a shell
    // that itself failed to load leaves the full viewport.
    <Center mih="calc(100dvh - var(--app-shell-header-offset, 0rem))" p="md">
      <Stack align="center" gap="xs" maw={440}>
        <ThemeIcon size={52} radius="xl" variant="light" color="red">
          <IconAlertTriangle size={26} stroke={1.5} />
        </ThemeIcon>
        <Text fw={600} mt="xs">
          This page couldn’t load
        </Text>
        <Text size="sm" c="dimmed" ta="center">
          {error instanceof Error && error.message
            ? error.message
            : 'Something went wrong while loading this page.'}
        </Text>
        <Button
          variant="default"
          mt="sm"
          leftSection={<IconRefresh size={16} stroke={1.7} />}
          loading={retrying}
          onClick={retry}
        >
          Try again
        </Button>
      </Stack>
    </Center>
  );
}
