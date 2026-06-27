import { Center, Loader, Stack } from '@mantine/core';
import { Brand } from '~components/app-shell/brand';

/**
 * Full-viewport loading state. In SPA mode this is prerendered as the static
 * shell (`_shell.html`) and shown on the initial client load until the router
 * resolves the matched route; it also covers slow route transitions.
 */
export function AppLoading() {
  return (
    <Center mih="100dvh" w="100%">
      <Stack align="center" gap="lg">
        <Brand size="lg" />
        <Loader size="sm" color="ember" type="dots" />
      </Stack>
    </Center>
  );
}
