import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDownload, IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import type { UserscriptInstallLink } from '~server/apps';
import { userscriptInstallLinksQueryOptions } from '~queries/apps';

function originOf(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function ScriptCard({ script }: { script: UserscriptInstallLink }) {
  const fullUrl = `${originOf()}${script.url}`;
  const grantLabels =
    script.grants.length === 0 ? ['auto-detect'] : script.grants;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text fw={600} size="sm" truncate>
              {script.name}
            </Text>
            {script.description ? (
              <Text size="xs" c="dimmed">
                {script.description}
              </Text>
            ) : null}
          </Stack>
          <Button
            component="a"
            href={fullUrl}
            size="xs"
            leftSection={<IconDownload size={16} stroke={1.8} />}
          >
            Install
          </Button>
        </Group>

        <Stack gap={4}>
          <Text size="xs" fw={500} c="dimmed">
            Matches
          </Text>
          <Group gap={6}>
            {script.matches.map((m) => (
              <Code key={m} style={{ fontSize: 'var(--mantine-font-size-xs)' }}>
                {m}
              </Code>
            ))}
          </Group>
        </Stack>

        <Group gap={16} wrap="wrap">
          <Group gap={6} align="center">
            <Text size="xs" fw={500} c="dimmed">
              Grants
            </Text>
            {grantLabels.map((g) => (
              <Badge key={g} size="xs" variant="light" color="gray">
                {g}
              </Badge>
            ))}
          </Group>
          {script.connects.length > 0 ? (
            <Group gap={6} align="center">
              <Text size="xs" fw={500} c="dimmed">
                Connects
              </Text>
              {script.connects.map((c) => (
                <Badge key={c} size="xs" variant="light" color="gray">
                  {c}
                </Badge>
              ))}
            </Group>
          ) : null}
          {script.runAt ? (
            <Group gap={6} align="center">
              <Text size="xs" fw={500} c="dimmed">
                Run at
              </Text>
              <Badge size="xs" variant="light" color="gray">
                {script.runAt}
              </Badge>
            </Group>
          ) : null}
        </Group>

        <Group gap={8} wrap="nowrap" align="center">
          <Code
            block
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--mantine-font-size-xs)',
            }}
          >
            {fullUrl}
          </Code>
          <Tooltip label="Copy install URL" withArrow position="left">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Copy install URL"
              onClick={() => {
                copy(fullUrl);
                toast.success('Install URL copied');
              }}
            >
              <IconCopy size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Stack>
    </Paper>
  );
}

/**
 * Lists the app's Tampermonkey userscripts with tokenized install/subscription
 * links. Each link carries a private app-level token so Tampermonkey can
 * auto-update without a platform login. Self-hides when the deployed app has no
 * userscripts (or hasn't deployed yet).
 */
export function BrowserScriptsPanel({ appId }: { appId: string }) {
  const query = useQuery(userscriptInstallLinksQueryOptions(appId));

  if (query.isLoading) {
    return (
      <Box component="section">
        <Text fw={600} fz="lg" mb="md">
          Browser scripts
        </Text>
        <Center py="lg">
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  const scripts = query.data ?? [];
  if (scripts.length === 0) return null;

  return (
    <Box component="section">
      <Text fw={600} fz="lg" mb="md">
        Browser scripts
      </Text>
      <Text size="sm" c="dimmed" mb="md">
        Tampermonkey userscripts this app publishes. Install a script, then
        Tampermonkey subscribes to the link and auto-updates it on each deploy.
        The link contains a private token — treat it like a secret.
      </Text>
      <Stack gap="md">
        {scripts.map((script) => (
          <ScriptCard key={script.id} script={script} />
        ))}
      </Stack>
    </Box>
  );
}
