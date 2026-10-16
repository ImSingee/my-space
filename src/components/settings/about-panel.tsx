import { Button, Group, Stack, Text } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
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
        <Group gap="sm">
          <Text size="sm" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
            {commit ?? 'Unknown'}
          </Text>
          {commit && (
            <Button
              type="button"
              variant="subtle"
              size="compact-xs"
              leftSection={<IconCopy size={14} />}
              onClick={async () => {
                if (await copy(commit).catch(() => false))
                  toast.success('Commit SHA copied');
                else toast.error('Could not copy commit SHA');
              }}
            >
              Copy SHA
            </Button>
          )}
        </Group>
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
