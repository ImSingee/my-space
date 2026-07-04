/** Persisted chat messages: user bubbles, assistant blocks, tool timelines. */
import { Box, Button, Group, Image, Paper, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconAppWindow, IconLayoutGrid } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Markdownish } from './markdownish';
import { ThinkingStep, ToolStep } from './steps';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  deployedAppIds,
  partsToImages,
  partsToText,
  toolDetail,
} from './types';
import classes from './chat.module.css';

type ToolResultMap = Map<string, ToolResultMessage>;

function AppActions({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <Group gap="xs" mt={6}>
      {ids.map((id) => (
        <Group key={id} gap={6}>
          <Button
            size="compact-sm"
            variant="light"
            color="ember"
            leftSection={<IconAppWindow size={14} />}
            renderRoot={(props) => (
              <Link to="/apps/$appId" params={{ appId: id }} {...props} />
            )}
          >
            Open {id}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconLayoutGrid size={14} />}
            renderRoot={(props) => (
              <Link
                to="/apps/$appId/manage"
                params={{ appId: id }}
                {...props}
              />
            )}
          >
            Details
          </Button>
        </Group>
      ))}
    </Group>
  );
}

/**
 * Render assistant blocks, grouping consecutive thinking/tool steps into one
 * connected timeline and keeping prose as clean standalone markdown.
 */
function AssistantBlocks({
  blocks,
  toolResults,
}: {
  blocks: AssistantBlock[];
  toolResults?: ToolResultMap;
}) {
  const out: ReactNode[] = [];
  let steps: ReactNode[] = [];

  const flush = () => {
    if (steps.length === 0) return;
    out.push(
      <Box key={`steps-${out.length}`} className={classes.steps}>
        {steps}
      </Box>,
    );
    steps = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      flush();
      out.push(<Markdownish key={index} text={block.text} />);
    } else if (block.type === 'thinking') {
      steps.push(<ThinkingStep key={index} text={block.thinking} />);
    } else {
      const result = toolResults?.get(block.id);
      steps.push(
        <ToolStep
          key={index}
          name={block.name}
          detail={toolDetail(block.name, block.arguments)}
          status="done"
          result={
            result
              ? { text: partsToText(result.content), isError: result.isError }
              : undefined
          }
        />,
      );
    }
  });
  flush();

  return <>{out}</>;
}

export function MessageView({
  message,
  toolResults,
}: {
  message: ChatMessage;
  toolResults?: ToolResultMap;
}) {
  if (message.role === 'user') {
    const text = partsToText(message.content);
    const images = partsToImages(message.content);
    return (
      <Box className={classes.userRow}>
        <Stack gap={6} align="flex-end" maw="80%">
          {images.length > 0 ? (
            <Group gap={6} justify="flex-end" wrap="wrap">
              {images.map((src, i) => (
                <Image
                  key={i}
                  src={src}
                  alt="Attached image"
                  radius="md"
                  w="auto"
                  mah={260}
                  className={classes.messageImage}
                />
              ))}
            </Group>
          ) : null}
          {text ? (
            <Paper className={classes.userBubble} radius="md" px="sm" py={6}>
              <Text className={classes.messageText}>{text}</Text>
            </Paper>
          ) : null}
        </Stack>
      </Box>
    );
  }

  // Standalone tool results are normally merged into their call above; this is
  // a fallback for any result we could not pair.
  if (message.role === 'toolResult') {
    return (
      <Box className={classes.steps}>
        <ToolStep
          name={message.toolName}
          status={message.isError ? 'error' : 'done'}
          result={{
            text: partsToText(message.content),
            isError: message.isError,
          }}
        />
      </Box>
    );
  }

  return (
    <Box className={classes.assistantRow}>
      <AssistantBlocks blocks={message.content} toolResults={toolResults} />
      <AppActions ids={deployedAppIds(message.content)} />
    </Box>
  );
}
