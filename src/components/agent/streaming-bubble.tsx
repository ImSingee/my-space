/** Live assistant turn: streams blocks in arrival order plus pending asks. */
import { Box, Group, Loader, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { AskAnswer } from '~agent/events';
import { AgentErrorNotice } from './agent-error-notice';
import { AskForm } from './ask-form';
import { Markdownish } from './markdownish';
import { StreamingThinkingStep, StreamingToolStep } from './steps';
import type { StreamState } from './use-agent-stream';
import classes from './chat.module.css';

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
  const working =
    state.active &&
    !state.terminalError &&
    !ask &&
    !hasText &&
    !thinkingVisible &&
    !anyToolRunning;

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
      {state.terminalError ? (
        <AgentErrorNotice message={state.terminalError} live />
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
