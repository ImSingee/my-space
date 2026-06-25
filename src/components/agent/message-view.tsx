import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Collapse,
  Group,
  Loader,
  Paper,
  Text,
  Typography,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link } from '@tanstack/react-router';
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCheck,
  IconExternalLink,
  IconLayoutGrid,
  IconTool,
} from '@tabler/icons-react';
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { StreamState } from './use-agent-stream';
import {
  type AssistantBlock,
  type ChatMessage,
  deployedSubappIds,
  partsToText,
  toolDetail,
  toolLabel,
} from './types';
import classes from './chat.module.css';

function MarkdownLink(props: ComponentPropsWithoutRef<'a'>) {
  return <Anchor {...props} target="_blank" rel="noreferrer" />;
}

function Markdownish({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown components={{ a: MarkdownLink }}>{text}</ReactMarkdown>
    </Typography>
  );
}

function SubappActions({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <Group gap="xs" mt={6}>
      {ids.map((id) => (
        <Group key={id} gap={6}>
          <Button
            size="compact-sm"
            variant="light"
            color="violet"
            leftSection={<IconExternalLink size={14} />}
            component="a"
            href={`/app/${id}/`}
            target="_blank"
            rel="noreferrer"
          >
            Open {id}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconLayoutGrid size={14} />}
            renderRoot={(props) => (
              <Link
                to="/subapps/$subappId"
                params={{ subappId: id }}
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

function ThinkingPanel({ text }: { text: string }) {
  const [open, handlers] = useDisclosure(false);
  if (!text.trim()) return null;
  return (
    <Box className={classes.thinking}>
      <UnstyledButton
        className={classes.collapseToggle}
        onClick={handlers.toggle}
      >
        <IconChevronRight
          size={14}
          className={open ? classes.chevronOpen : classes.chevron}
        />
        <Text size="xs" c="dimmed" fw={500}>
          Thinking
        </Text>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Text size="xs" c="dimmed" className={classes.messageText} mt={4}>
          {text}
        </Text>
      </Collapse>
    </Box>
  );
}

export function ToolChip({
  name,
  detail,
  done,
  isError,
}: {
  name: string;
  detail?: string;
  done: boolean;
  isError?: boolean;
}) {
  const color = isError ? 'red' : done ? 'teal' : 'violet';
  const icon = isError ? (
    <IconAlertTriangle size={12} />
  ) : done ? (
    <IconCheck size={12} />
  ) : (
    <Loader size={10} color="violet" />
  );
  return (
    <Badge
      variant="light"
      color={color}
      radius="sm"
      leftSection={icon}
      className={classes.toolChip}
    >
      {toolLabel(name)}
      {detail ? (
        <Text span className={classes.toolChipDetail}>
          {' · '}
          {detail}
        </Text>
      ) : null}
    </Badge>
  );
}

function ToolResultPanel({
  toolName,
  text,
  isError,
}: {
  toolName: string;
  text: string;
  isError?: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  return (
    <Box className={classes.toolResult}>
      <UnstyledButton
        className={classes.collapseToggle}
        onClick={handlers.toggle}
      >
        <IconChevronRight
          size={14}
          className={open ? classes.chevronOpen : classes.chevron}
        />
        <IconTool size={13} />
        <Text size="xs" c={isError ? 'red' : 'dimmed'} fw={500}>
          {toolLabel(toolName)} result
        </Text>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Code block className={classes.toolResultBody}>
          {text || '(no output)'}
        </Code>
      </Collapse>
    </Box>
  );
}

function AssistantBlocks({ blocks }: { blocks: AssistantBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'text') {
          return <Markdownish key={index} text={block.text} />;
        }
        if (block.type === 'thinking') {
          return <ThinkingPanel key={index} text={block.thinking} />;
        }
        return (
          <Group key={index} gap={6} my={2}>
            <ToolChip
              name={block.name}
              detail={toolDetail(block.name, block.arguments)}
              done
            />
          </Group>
        );
      })}
    </>
  );
}

export function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <Box className={classes.userRow}>
        <Paper className={classes.userBubble} radius="lg" px="md" py="xs">
          <Text className={classes.messageText}>
            {partsToText(message.content)}
          </Text>
        </Paper>
      </Box>
    );
  }

  if (message.role === 'toolResult') {
    return (
      <ToolResultPanel
        toolName={message.toolName}
        text={partsToText(message.content)}
        isError={message.isError}
      />
    );
  }

  return (
    <Box className={classes.assistantRow}>
      <AssistantBlocks blocks={message.content} />
      <SubappActions ids={deployedSubappIds(message.content)} />
    </Box>
  );
}

export function StreamingBubble({ state }: { state: StreamState }) {
  const hasContent = state.text || state.thinking || state.tools.length > 0;
  return (
    <Box className={classes.assistantRow}>
      {state.thinking ? <ThinkingPanel text={state.thinking} /> : null}
      {state.tools.length > 0 ? (
        <Group gap={6} my={4}>
          {state.tools.map((t) => (
            <ToolChip
              key={t.id}
              name={t.name}
              detail={toolDetail(t.name, t.args)}
              done={t.done}
              isError={t.isError}
            />
          ))}
        </Group>
      ) : null}
      {state.text ? <Markdownish text={state.text} /> : null}
      {!hasContent ? (
        <Group gap={8} c="dimmed">
          <Loader size="xs" type="dots" />
          <Text size="sm" c="dimmed">
            Thinking…
          </Text>
        </Group>
      ) : null}
    </Box>
  );
}
