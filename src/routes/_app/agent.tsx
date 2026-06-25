import { Box, Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { IconSparkles } from '@tabler/icons-react';
import { Suspense, useState } from 'react';
import { Chat } from '~components/agent/chat';
import { SessionsPanel } from '~components/agent/sessions-panel';
import { providersQueryOptions, sessionsQueryOptions } from '~queries/agent';
import classes from '~components/agent/chat.module.css';

export const Route = createFileRoute('/_app/agent')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionsQueryOptions),
      context.queryClient.ensureQueryData(providersQueryOptions),
    ]);
  },
  component: AgentPage,
});

function AgentPage() {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Box className={classes.root}>
      <Suspense
        fallback={
          <Center style={{ flex: 1 }}>
            <Loader />
          </Center>
        }
      >
        <SessionsPanel selected={selected} onSelect={setSelected} />
        {selected ? (
          <Chat key={selected} sessionId={selected} />
        ) : (
          <Box className={classes.empty}>
            <Stack align="center" gap={6}>
              <ThemeIcon size={52} radius="xl" variant="light" color="violet">
                <IconSparkles size={26} stroke={1.5} />
              </ThemeIcon>
              <Text fw={600}>Start a new chat</Text>
              <Text size="sm" c="dimmed">
                Create a chat to start building with the Agent.
              </Text>
            </Stack>
          </Box>
        )}
      </Suspense>
    </Box>
  );
}
