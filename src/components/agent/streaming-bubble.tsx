/** Live assistant turn: streams blocks in arrival order plus pending asks. */
import { Box, Group, Loader, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { AskAnswer } from '~agent/events';
import { AgentErrorNotice } from './agent-error-notice';
import { AskForm } from './ask-form';
import { finalTextIndex } from './chat-turns';
import { Markdownish } from './markdownish';
import { EnvForm, type EnvEntry } from './env-form';
import { StreamingThinkingStep, StreamingToolStep } from './steps';
import type { StreamBlock, StreamState } from './use-agent-stream';
import { type WorkFrame, WorkProcess } from './work-process';
import classes from './chat.module.css';

function streamText(block: StreamBlock): string | undefined {
  return block.kind === 'text' ? block.text : undefined;
}

export function StreamingBubble({
  state,
  onAnswer,
  onSubmitEnv,
  work,
}: {
  state: StreamState;
  onAnswer: (askId: string, answers: AskAnswer[]) => void;
  onSubmitEnv: (requestId: string, entries: EnvEntry[]) => Promise<boolean>;
  /**
   * Frames the process in the Working/Worked container. While the run is
   * going everything is process; once it settles the final answer moves out.
   * The chat always provides it.
   */
  work?: WorkFrame;
}) {
  const ask = state.pendingAsk;
  const envRequest = state.pendingEnvRequest;

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
  const renderBlocks = (start: number, end: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let steps: ReactNode[] = [];
    const flush = () => {
      if (steps.length === 0) return;
      out.push(
        <Box key={`steps-${start}-${out.length}`} className={classes.steps}>
          {steps}
        </Box>,
      );
      steps = [];
    };

    for (let index = start; index < end; index += 1) {
      const block = state.blocks[index];
      if (block.kind === 'text') {
        flush();
        if (block.text) out.push(<Markdownish key={index} text={block.text} />);
      } else if (block.kind === 'thinking') {
        // Some providers (OpenAI reasoning summaries via the relay) stream
        // only empty "\n\n" separator deltas while reasoning and deliver the
        // real summary at the end; skip whitespace-only segments so they don't
        // render as blank rows (the "Thinking…" loader covers that phase).
        if (!block.text.trim()) continue;
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
    }
    flush();
    return out;
  };

  const split =
    work && state.outcome ? finalTextIndex(state.blocks, streamText) : -1;
  const processEnd = split === -1 ? state.blocks.length : split;
  const process = renderBlocks(0, processEnd);
  const final = renderBlocks(processEnd, state.blocks.length);

  // While the turn is live, whenever nothing else is visibly in flight —
  // before the first token, between tool calls, or during whitespace-only
  // reasoning — show a loading row so the agent never looks stalled. A running
  // tool, an actively streaming thinking block, streaming answer text, or a
  // pending human-input request carry their own progress signal. Earlier prose
  // must not hide later waiting phases.
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
    !envRequest &&
    !state.textActive &&
    !thinkingVisible &&
    !anyToolRunning;
  const workingIndicator = working ? (
    <Group gap={8} c="dimmed">
      <Loader size="xs" type="dots" />
      <Text size="sm" c="dimmed">
        Thinking…
      </Text>
    </Group>
  ) : null;

  return (
    <Box className={classes.assistantRow}>
      {work ? (
        <WorkProcess
          frame={work}
          hasProcess={process.length > 0 || workingIndicator !== null}
        >
          {process}
          {workingIndicator}
        </WorkProcess>
      ) : (
        process
      )}
      {final}
      {/* Human input and the failure stay outside the collapsible process. */}
      {ask ? (
        <AskForm
          key={ask.askId}
          questions={ask.questions}
          onSubmit={(answers) => onAnswer(ask.askId, answers)}
        />
      ) : null}
      {envRequest ? (
        <EnvForm
          key={`${state.runId ?? 'pending'}:${envRequest.requestId}`}
          reason={envRequest.reason}
          variables={envRequest.variables}
          onSubmit={(entries) => onSubmitEnv(envRequest.requestId, entries)}
        />
      ) : null}
      {state.terminalError ? (
        <AgentErrorNotice message={state.terminalError} live />
      ) : null}
      {work ? null : workingIndicator}
    </Box>
  );
}
