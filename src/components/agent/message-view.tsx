import {
  Anchor,
  Box,
  Button,
  Collapse,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
  Typography,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link } from '@tanstack/react-router';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconExternalLink,
  IconLayoutGrid,
  IconSparkles,
} from '@tabler/icons-react';
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useRef,
} from 'react';
import ReactMarkdown from 'react-markdown';
import type { AskAnswer } from '~agent/events';
import { AskForm } from './ask-form';
import type { StreamState, StreamTool } from './use-agent-stream';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  deployedAppIds,
  partsToImages,
  partsToText,
  toolDetail,
  toolLabel,
} from './types';
import classes from './chat.module.css';

type ToolResultMap = Map<string, ToolResultMessage>;
type ToolStatus = 'running' | 'done' | 'error';

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
 * One quiet line in the agent's activity timeline. Used for thinking and tool
 * calls/results alike so the whole "process" reads with a single visual
 * language instead of mixed chips and boxes. Expands in place when it has a
 * body (result or thinking text).
 */
function StepRow({
  icon,
  label,
  detail,
  error,
  children,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  error?: boolean;
  children?: ReactNode;
}) {
  const [open, handlers] = useDisclosure(false);
  const expandable = Boolean(children);
  const inner = (
    <>
      <span className={error ? classes.stepIconError : classes.stepIcon}>
        {icon}
      </span>
      <span className={classes.stepLabel}>{label}</span>
      {detail ? <span className={classes.stepDetail}>{detail}</span> : null}
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );
  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {inner}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{inner}</Box>
      )}
      {expandable ? <Collapse expanded={open}>{children}</Collapse> : null}
    </Box>
  );
}

function ThinkingStep({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <StepRow icon={<IconSparkles size={13} stroke={1.6} />} label="Thinking">
      <Box className={classes.stepBody}>
        <Box className={classes.stepBodyText}>{text}</Box>
      </Box>
    </StepRow>
  );
}

function ToolStep({
  name,
  detail,
  status,
  result,
}: {
  name: string;
  detail?: string;
  status: ToolStatus;
  result?: { text: string; isError?: boolean };
}) {
  const isError = status === 'error' || result?.isError === true;
  const icon =
    status === 'running' ? (
      <Loader size={11} color="gray" />
    ) : isError ? (
      <IconAlertTriangle size={14} stroke={1.7} />
    ) : (
      <IconCheck size={14} stroke={2} />
    );
  return (
    <StepRow
      icon={icon}
      label={toolLabel(name)}
      detail={detail}
      error={isError}
    >
      {result ? (
        <Box className={classes.stepBody}>
          <Box className={classes.stepBodyCode}>
            {result.text || '(no output)'}
          </Box>
        </Box>
      ) : null}
    </StepRow>
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
            <Paper className={classes.userBubble} radius="lg" px="md" py="xs">
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

/**
 * Thinking in the live stream. While the model is reasoning it shows the
 * thinking text in real time (auto-scrolled); once it moves on to answering or
 * tools, it collapses to a quiet, re-expandable "Thinking" row.
 */
function StreamingThinkingStep({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [open, handlers] = useDisclosure(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [text, active]);

  if (!text.trim()) return null;
  const showBody = active || open;
  const expandable = !active;
  const header = (
    <>
      <span className={classes.stepIcon}>
        {active ? (
          <Loader size={11} color="gray" />
        ) : (
          <IconSparkles size={13} stroke={1.6} />
        )}
      </span>
      <span className={classes.stepLabel}>
        {active ? 'Thinking…' : 'Thinking'}
      </span>
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );

  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      {showBody ? (
        <Box className={classes.stepBody}>
          <Box ref={bodyRef} className={classes.stepBodyText}>
            {text}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * A tool step in the live stream. While running it follows the tool's output
 * in real time (auto-scrolled); once finished it collapses to a quiet,
 * re-expandable row, matching the persisted timeline.
 */
function StreamingToolStep({ tool }: { tool: StreamTool }) {
  const [open, handlers] = useDisclosure(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = !tool.done;
  const isError = tool.isError === true;
  const hasOutput = Boolean(tool.output);
  const showBody = running ? hasOutput : open && hasOutput;
  const expandable = !running && hasOutput;

  useEffect(() => {
    if (running && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [tool.output, running]);

  const icon = running ? (
    <Loader size={11} color="gray" />
  ) : isError ? (
    <IconAlertTriangle size={14} stroke={1.7} />
  ) : (
    <IconCheck size={14} stroke={2} />
  );
  const detail = toolDetail(tool.name, tool.args);
  const header = (
    <>
      <span className={isError ? classes.stepIconError : classes.stepIcon}>
        {icon}
      </span>
      <span className={classes.stepLabel}>{toolLabel(tool.name)}</span>
      {detail ? <span className={classes.stepDetail}>{detail}</span> : null}
      {expandable ? (
        <IconChevronRight
          size={14}
          className={open ? classes.stepChevronOpen : classes.stepChevron}
        />
      ) : null}
    </>
  );

  return (
    <Box>
      {expandable ? (
        <UnstyledButton
          className={classes.stepHeader}
          onClick={handlers.toggle}
        >
          {header}
        </UnstyledButton>
      ) : (
        <Box className={classes.stepHeader}>{header}</Box>
      )}
      {showBody ? (
        <Box className={classes.stepBody}>
          <Box ref={bodyRef} className={classes.stepBodyCode}>
            {tool.output}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function StreamingBubble({
  state,
  onAnswer,
}: {
  state: StreamState;
  onAnswer: (askId: string, answers: AskAnswer[]) => void;
}) {
  const ask = state.pendingAsk;
  const hasContent =
    state.text || state.thinking || state.tools.length > 0 || Boolean(ask);
  const hasSteps = Boolean(state.thinking) || state.tools.length > 0;

  return (
    <Box className={classes.assistantRow}>
      {hasSteps ? (
        <Box className={classes.steps}>
          <StreamingThinkingStep
            text={state.thinking}
            active={state.thinkingActive}
          />
          {state.tools.map((t) => (
            <StreamingToolStep key={t.id} tool={t} />
          ))}
        </Box>
      ) : null}
      {state.text ? <Markdownish text={state.text} /> : null}
      {ask ? (
        <AskForm
          key={ask.askId}
          questions={ask.questions}
          onSubmit={(answers) => onAnswer(ask.askId, answers)}
        />
      ) : null}
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
