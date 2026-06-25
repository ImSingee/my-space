import { ActionIcon, Box, Center, Drawer, Loader, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { createFileRoute } from '@tanstack/react-router';
import { IconMessages } from '@tabler/icons-react';
import { Suspense, useState } from 'react';
import { Chat, type ChatDraft } from '~components/agent/chat';
import { NewChat } from '~components/agent/new-chat';
import { SessionsPanel } from '~components/agent/sessions-panel';
import { providersQueryOptions, sessionsQueryOptions } from '~queries/agent';
import classes from '~components/agent/chat.module.css';

export const Route = createFileRoute('/_app/agent')({
  validateSearch: (search): { prompt?: string } => ({
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(sessionsQueryOptions),
      context.queryClient.ensureQueryData(providersQueryOptions),
    ]);
  },
  component: AgentPage,
});

function AgentPage() {
  const { prompt } = Route.useSearch();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    sessionId: string;
    draft: ChatDraft;
  } | null>(null);
  const [drawerOpened, drawer] = useDisclosure(false);

  const openSession = (id: string | null) => {
    setSelected(id);
    setDraft(null);
    drawer.close();
  };

  return (
    <Box className={classes.root}>
      <Suspense
        fallback={
          <Center style={{ flex: 1 }}>
            <Loader />
          </Center>
        }
      >
        <Box className={classes.sessionsRail}>
          <SessionsPanel selected={selected} onSelect={openSession} />
        </Box>

        <Drawer
          opened={drawerOpened}
          onClose={drawer.close}
          position="left"
          size={300}
          title="Chats"
          padding="md"
          classNames={{ body: classes.drawerBody }}
        >
          <SessionsPanel selected={selected} onSelect={openSession} />
        </Drawer>

        <Box className={classes.agentMain}>
          <Box className={classes.mobileBar}>
            <ActionIcon
              variant="default"
              radius="md"
              aria-label="Open chats"
              onClick={drawer.open}
            >
              <IconMessages size={18} stroke={1.6} />
            </ActionIcon>
            <Text fw={600} size="sm" truncate>
              {selected ? 'Chat' : 'New chat'}
            </Text>
          </Box>

          {selected ? (
            <Chat
              key={selected}
              sessionId={selected}
              initialDraft={
                draft?.sessionId === selected ? draft.draft : undefined
              }
            />
          ) : (
            <NewChat
              initialPrompt={prompt}
              onStart={(id, d) => {
                setDraft({ sessionId: id, draft: d });
                setSelected(id);
              }}
            />
          )}
        </Box>
      </Suspense>
    </Box>
  );
}
