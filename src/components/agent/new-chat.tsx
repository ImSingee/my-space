import {
  Box,
  Button,
  Card,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconPlugConnected, IconSparkles } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { sessionsQueryOptions } from '~queries/agent';
import { Composer, type ComposerSubmit } from './composer';
import { ModelPicker } from './model-picker';
import { useModelOptions } from './model-options';
import { resolveEffectiveModel, splitModelValue } from './model-value';
import { createEmptyAgentSession } from './new-chat-api';
import { startAgentRunRequest } from './use-agent-stream';
import classes from './chat.module.css';

const EXAMPLE_PROMPTS = [
  'A daily habit tracker',
  'A personal bookmarks manager',
  'A workout log with charts',
  'A simple expense tracker',
];

/**
 * The prompt-first landing for the Agent: type (or pick an example) and send.
 * Sending creates a session and hands the draft up so the chat streams the
 * first reply immediately — no "create a chat first" dead-end.
 */
export function NewChat({
  onStart,
  initialPrompt,
}: {
  onStart: (sessionId: string) => void;
  initialPrompt?: string;
}) {
  const qc = useQueryClient();
  const { groups, first, available } = useModelOptions();
  const [model, setModel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Reuse a session created by a failed first attempt so a retry doesn't leave
  // a trail of empty "New chat" shells in the sidebar.
  const createdSessionRef = useRef<string | null>(null);
  const [seed, setSeed] = useState({
    text: initialPrompt ?? '',
    nonce: initialPrompt ? 1 : 0,
  });

  const effectiveModel = resolveEffectiveModel(model, null, available, first);

  const start = async ({ text, images }: ComposerSubmit): Promise<boolean> => {
    if (creating) return false;
    const value = effectiveModel;
    if (!value) return false;
    const parsed = splitModelValue(value);
    if (!parsed) return false;
    const { providerId, modelId } = parsed;

    setCreating(true);
    try {
      const id =
        createdSessionRef.current ?? (await createEmptyAgentSession()).id;
      createdSessionRef.current = id;
      await startAgentRunRequest({
        sessionId: id,
        userText: text,
        images,
        providerId,
        modelId,
      });
      await qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
      onStart(id);
      return true;
    } catch (error) {
      // Keep the draft (return false) so the user can retry without retyping.
      // The created session id is retained (createdSessionRef) so the retry
      // reuses it instead of creating another empty session.
      toast.error(
        error instanceof Error ? error.message : 'Could not start the chat.',
      );
      setCreating(false);
      return false;
    }
  };

  return (
    <Box className={classes.hero}>
      <Stack className={classes.heroInner} gap="lg">
        <Stack gap={8} align="center">
          <ThemeIcon size={56} radius="xl" variant="light" color="ember">
            <IconSparkles size={28} stroke={1.5} />
          </ThemeIcon>
          <Title order={2} className={classes.heroTitle}>
            What do you want to build?
          </Title>
          <Text c="dimmed" ta="center" maw={440}>
            Describe an app in plain language. The Agent scaffolds, builds, and
            deploys it for you — then it lives in your sidebar and dashboards.
          </Text>
        </Stack>

        {first === null ? (
          <Card withBorder radius="lg" padding="lg" className={classes.guard}>
            <Stack align="center" gap="xs">
              <ThemeIcon size={44} radius="xl" variant="light" color="gray">
                <IconPlugConnected size={22} stroke={1.6} />
              </ThemeIcon>
              <Text fw={600}>Connect an AI provider to start</Text>
              <Text size="sm" c="dimmed" ta="center" maw={380}>
                Add a provider and enable a model in Settings, then come back to
                start building.
              </Text>
              <Button
                component={Link}
                to="/settings"
                mt="xs"
                leftSection={<IconPlugConnected size={16} stroke={1.7} />}
              >
                Go to Settings
              </Button>
            </Stack>
          </Card>
        ) : (
          <>
            <Composer
              onSubmit={start}
              disabled={creating}
              focusOnMount
              placeholder="Describe the app you want to build…"
              seedText={seed.text}
              seedNonce={seed.nonce}
              modelControl={
                <ModelPicker
                  groups={groups}
                  value={effectiveModel}
                  onChange={setModel}
                  disabled={creating}
                />
              }
            />

            <Group gap="xs" justify="center">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <Button
                  key={prompt}
                  variant="default"
                  size="xs"
                  radius="xl"
                  onClick={() =>
                    setSeed((s) => ({ text: prompt, nonce: s.nonce + 1 }))
                  }
                >
                  {prompt}
                </Button>
              ))}
            </Group>
          </>
        )}
      </Stack>
    </Box>
  );
}
