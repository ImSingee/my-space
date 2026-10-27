import { Alert, Code, Stack, Text } from '@mantine/core';
import type { ExtraPermissionsView } from '~/extra-permissions';

export function ExtraPermissionsDetails({
  access,
}: {
  access: ExtraPermissionsView | null;
}) {
  if (!access || access.flags.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {access ? 'None declared' : 'Not deployed'}
      </Text>
    );
  }
  return (
    <Stack gap="xs" style={{ minWidth: 0 }}>
      {access.flags.map((flag) => (
        <Code
          key={flag}
          block
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {flag}
        </Code>
      ))}
      {access.hostAccess ? (
        <Alert
          color="orange"
          title={
            <Text size="sm" fw={600} c="orange.8">
              Host access
            </Text>
          }
        >
          These permissions grant host access as the platform OS user. App and
          Workflow processes share that user and can access platform credentials
          and other Apps’ data.
        </Alert>
      ) : null}
    </Stack>
  );
}
