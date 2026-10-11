/** Persisted chat messages: user bubbles, assistant blocks, tool timelines. */
import { Box, Group, Image, Paper, Stack, Text } from '@mantine/core';
import { IconDownload, IconFile } from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';
import {
  composerModelText,
  type AgentComposerContentPart,
} from '~agent/composer-content';
import { formatBytes } from '~lib/format';
import type { AppListItem } from '~server/apps';
import type { WorkflowListItem } from '~server/workflows';
import { AgentErrorNotice } from './agent-error-notice';
import { finalTextIndex } from './chat-turns';
import { useComposerMessageCopy } from './composer-message-copy';
import {
  AppDeploymentActions,
  WorkflowDeploymentActions,
} from './deployment-actions';
import { Markdownish } from './markdownish';
import { ThinkingStep, ToolStep } from './steps';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  partsToImages,
  partsToText,
  successfullyDeployedAppIds,
  successfullyDeployedWorkflowIds,
  toolDetail,
} from './types';
import { type WorkFrame, WorkProcess } from './work-process';
import classes from './chat.module.css';

type ToolResultMap = Map<string, ToolResultMessage>;

function UserComposerText({
  content,
  fallback,
}: {
  content: AgentComposerContentPart[] | undefined;
  fallback: string;
}) {
  const ref = useComposerMessageCopy(
    content?.some((part) => part.type !== 'text') ?? false,
  );
  const id = useId();
  return (
    <span ref={ref}>
      {!content || content.length === 0
        ? fallback
        : content.map((part, index) =>
            part.type === 'text' ? (
              part.text
            ) : (
              <span
                key={`${part.id}-${index}`}
                className={classes.messageAppMention}
                data-composer-reference={composerModelText([part])}
                data-composer-reference-key={`${id}-${index}`}
              >
                @{part.name}
              </span>
            ),
          )}
    </span>
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
          args={block.arguments}
          detail={toolDetail(block.name, block.arguments)}
          status="done"
          result={
            result
              ? {
                  text: partsToText(result.content),
                  details: result.details,
                  isError: result.isError,
                }
              : undefined
          }
        />,
      );
    }
  });
  flush();

  return <>{out}</>;
}

function assistantText(block: AssistantBlock): string | undefined {
  return block.type === 'text' ? block.text : undefined;
}

/** Whether any block renders something (whitespace-only blocks render nothing). */
function hasVisibleBlocks(blocks: AssistantBlock[]): boolean {
  return blocks.some((block) =>
    block.type === 'text'
      ? Boolean(block.text.trim())
      : block.type === 'thinking'
        ? Boolean(block.thinking.trim())
        : true,
  );
}

export function MessageView({
  message,
  toolResults,
  onRetry,
  retrying = false,
  retryDisabled = false,
  apps,
  workflows,
  work,
}: {
  message: ChatMessage;
  toolResults?: ToolResultMap;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  apps?: AppListItem[];
  workflows?: WorkflowListItem[];
  /**
   * Frames an assistant reply's process in the Working/Worked container and
   * keeps its final answer outside. The chat always provides it.
   */
  work?: WorkFrame;
}) {
  if (message.role === 'user') {
    const text = partsToText(
      message.content,
      message.attachments,
      message.composerContent,
    );
    const images = partsToImages(message.content);
    const files = message.attachments ?? [];
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
          {files.length > 0 ? (
            <Box className={classes.messageFiles}>
              {files.map((file) => (
                <Box
                  component="a"
                  key={file.id}
                  href={`/api/agent/attachments/${encodeURIComponent(file.id)}`}
                  download={file.name}
                  className={classes.messageFile}
                  title={`${file.name} (${formatBytes(file.size)})`}
                >
                  <IconFile size={16} stroke={1.7} />
                  <Text size="xs" className={classes.messageFileName}>
                    {file.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatBytes(file.size)}
                  </Text>
                  <IconDownload size={14} stroke={1.7} />
                </Box>
              ))}
            </Box>
          ) : null}
          {text ? (
            <Paper className={classes.userBubble} radius="md" px="sm" py={6}>
              <Text className={classes.messageText}>
                <UserComposerText
                  content={message.composerContent}
                  fallback={text}
                />
              </Text>
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
            details: message.details,
            isError: message.isError,
          }}
        />
      </Box>
    );
  }

  // A running reply has no final answer yet; everything is still process.
  const finalIndex =
    work && work.phase !== 'running'
      ? finalTextIndex(message.content, assistantText)
      : -1;
  const processBlocks =
    finalIndex === -1 ? message.content : message.content.slice(0, finalIndex);
  const finalBlocks =
    finalIndex === -1 ? [] : message.content.slice(finalIndex);

  return (
    <Box className={classes.assistantRow}>
      {work ? (
        <>
          <WorkProcess
            frame={work}
            hasProcess={hasVisibleBlocks(processBlocks)}
          >
            <AssistantBlocks blocks={processBlocks} toolResults={toolResults} />
          </WorkProcess>
          <AssistantBlocks blocks={finalBlocks} toolResults={toolResults} />
        </>
      ) : (
        <AssistantBlocks blocks={message.content} toolResults={toolResults} />
      )}
      <AppDeploymentActions
        ids={successfullyDeployedAppIds(message.content, toolResults)}
        apps={apps}
      />
      <WorkflowDeploymentActions
        ids={successfullyDeployedWorkflowIds(message.content, toolResults)}
        workflows={workflows}
      />
      {message.stopReason === 'error' ? (
        <AgentErrorNotice
          message={message.errorMessage}
          onRetry={onRetry}
          retrying={retrying}
          retryDisabled={retryDisabled}
        />
      ) : null}
    </Box>
  );
}
