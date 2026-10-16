import { Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { buildInfo } from '~/build-info';

export function AboutPanel() {
  const { commit, commitTime } = buildInfo;
  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          Commit
        </Text>
        {commit ? (
          <Tooltip label="Copy commit SHA" withArrow>
            <UnstyledButton
              type="button"
              aria-label={`Copy commit SHA ${commit}`}
              ff="monospace"
              fz="sm"
              w="fit-content"
              maw="100%"
              style={{ overflowWrap: 'anywhere' }}
              onClick={async () => {
                if (await copy(commit).catch(() => false))
                  toast.success('Commit SHA copied');
                else toast.error('Could not copy commit SHA');
              }}
            >
              {commit}
            </UnstyledButton>
          </Tooltip>
        ) : (
          <Text size="sm" ff="monospace">
            Unknown
          </Text>
        )}
      </Stack>
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          Commit time
        </Text>
        <Text size="sm">
          {commitTime ? (
            <time dateTime={commitTime}>{commitTime}</time>
          ) : (
            'Unknown'
          )}
        </Text>
      </Stack>
    </Stack>
  );
}
