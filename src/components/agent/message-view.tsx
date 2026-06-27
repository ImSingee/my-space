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
  IconAppWindow,
  IconCheck,
  IconChevronRight,
  IconLayoutGrid,
  IconSparkles,
} from '@tabler/icons-react';
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  memo,
  useEffect,
  useRef,
} from 'react';
import ReactMarkdown, { type Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
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

type PluginList = NonNullable<MarkdownOptions['rehypePlugins']>;
const REMARK_PLUGINS: PluginList = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: PluginList = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];
const MARKDOWN_COMPONENTS = { a: MarkdownLink };

/**
 * Normalize the `\( … \)` / `\[ … \]` math delimiters that LLMs emit into the
 * `$ … $` / `$$ … $$` that remark-math understands. Display math is forced onto
 * its own block (blank lines around `$$`) so adjacent equations on soft-wrapped
 * lines can't have their `$$` pairs mismatched. Inner whitespace is trimmed
 * because remark-math treats `$ x $` (space next to the dollar) as plain text.
 */
function normalizeMath(text: string): string {
  return text
    .replace(
      /\\\[([\s\S]+?)\\\]/g,
      (_m, expr: string) => `\n\n$$\n${expr.trim()}\n$$\n\n`,
    )
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, expr: string) => `$${expr.trim()}$`);
}

// Memoized on `text`: during streaming the live bubble re-renders every token,
// but only the actively-growing text block's `text` changes. Completed blocks
// (and the whole history) keep the same string, so React.memo skips the
// expensive react-markdown + KaTeX parse for them — keeping per-token work O(1)
// instead of O(blocks).
const Markdownish = memo(function Markdownish({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <Typography className={classes.markdown}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </Typography>
  );
});

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
            {text.trimStart()}
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

  // The last thinking block is the only one that may still be streaming.
  let lastThinkingIndex = -1;
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    if (state.blocks[i].kind === 'thinking') {
      lastThinkingIndex = i;
      break;
    }
  }

  // Walk blocks in arrival order, grouping consecutive thinking/tool steps into
  // one connected timeline and flushing on prose — so a multi-step reply (and
  // each distinct reasoning segment) reads identically live and afterwards.
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

  state.blocks.forEach((block, index) => {
    if (block.kind === 'text') {
      flush();
      if (block.text) out.push(<Markdownish key={index} text={block.text} />);
    } else if (block.kind === 'thinking') {
      // Some providers (OpenAI reasoning summaries via the relay) stream only
      // empty "\n\n" separator deltas while reasoning and deliver the real
      // summary at the end; skip whitespace-only segments so they don't render
      // as blank rows (the "Thinking…" loader below covers that phase).
      if (!block.text.trim()) return;
      steps.push(
        <StreamingThinkingStep
          key={index}
          text={block.text}
          active={index === lastThinkingIndex && state.thinkingActive}
        />,
      );
    } else {
      steps.push(<StreamingToolStep key={index} tool={block.tool} />);
    }
  });
  flush();

  // This bubble only mounts while the turn is live, so whenever nothing else is
  // visibly in flight — before the first token, between tool calls, or during
  // whitespace-only reasoning — show a loading row so the agent never looks
  // stalled. A running tool, an actively streaming thinking block, answer text,
  // or a pending ask each carry their own progress signal.
  const hasText = state.blocks.some(
    (b) => b.kind === 'text' && b.text.length > 0,
  );
  const anyToolRunning = state.blocks.some(
    (b) => b.kind === 'tool' && !b.tool.done,
  );
  const lastThinkingBlock = state.blocks[lastThinkingIndex];
  const thinkingVisible =
    state.thinkingActive &&
    lastThinkingBlock?.kind === 'thinking' &&
    Boolean(lastThinkingBlock.text.trim());
  const working = !ask && !hasText && !thinkingVisible && !anyToolRunning;

  return (
    <Box className={classes.assistantRow}>
      {out}
      {ask ? (
        <AskForm
          key={ask.askId}
          questions={ask.questions}
          onSubmit={(answers) => onAnswer(ask.askId, answers)}
        />
      ) : null}
      {working ? (
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
