import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '~agent/events';
import { reduceStreamState, type StreamState } from './use-agent-stream';

const question: AskQuestion = {
  id: 'question_1',
  prompt: 'Pick one',
  options: [{ id: 'option_1', label: 'Option 1' }],
  allowMultiple: false,
};

function baseState(): StreamState {
  return {
    active: true,
    runId: 'run_1',
    blocks: [],
    thinkingActive: false,
    pendingAsk: undefined,
  };
}

describe('reduceStreamState', () => {
  it('clears an ask when the matching answered event is replayed', () => {
    let state = reduceStreamState(baseState(), {
      type: 'ask',
      askId: 'ask_1',
      questions: [question],
    });

    expect(state.pendingAsk?.askId).toBe('ask_1');

    state = reduceStreamState(state, {
      type: 'ask_answered',
      askId: 'ask_1',
    });

    expect(state.pendingAsk).toBeUndefined();
  });

  it('keeps the current ask when an older ask is answered', () => {
    const state = reduceStreamState(
      {
        ...baseState(),
        pendingAsk: { askId: 'ask_2', questions: [question] },
      },
      {
        type: 'ask_answered',
        askId: 'ask_1',
      },
    );

    expect(state.pendingAsk?.askId).toBe('ask_2');
  });

  it('continues streaming after an answered ask is replayed', () => {
    let state = reduceStreamState(baseState(), {
      type: 'ask',
      askId: 'ask_1',
      questions: [question],
    });
    state = reduceStreamState(state, {
      type: 'ask_answered',
      askId: 'ask_1',
    });
    state = reduceStreamState(state, { type: 'text', delta: 'Done.' });

    expect(state.pendingAsk).toBeUndefined();
    expect(state.blocks).toEqual([{ kind: 'text', text: 'Done.' }]);
  });

  it('merges consecutive thinking deltas into one block', () => {
    let state = reduceStreamState(baseState(), {
      type: 'thinking',
      delta: 'Plan ',
    });
    state = reduceStreamState(state, { type: 'thinking', delta: 'A' });

    expect(state.blocks).toEqual([{ kind: 'thinking', text: 'Plan A' }]);
    expect(state.thinkingActive).toBe(true);
  });

  it('starts a new thinking block after text or a tool interrupts it', () => {
    let state = reduceStreamState(baseState(), {
      type: 'thinking',
      delta: 'first',
    });
    state = reduceStreamState(state, { type: 'text', delta: 'answer' });
    state = reduceStreamState(state, {
      type: 'tool_start',
      id: 'call_1',
      name: 'read_file',
      args: {},
    });
    state = reduceStreamState(state, { type: 'thinking', delta: 'second' });

    expect(state.blocks.map((b) => b.kind)).toEqual([
      'thinking',
      'text',
      'tool',
      'thinking',
    ]);
    const thinking = state.blocks.filter((b) => b.kind === 'thinking');
    expect(thinking).toEqual([
      { kind: 'thinking', text: 'first' },
      { kind: 'thinking', text: 'second' },
    ]);
  });

  it('starts a new thinking block for each assistant turn', () => {
    let state = reduceStreamState(baseState(), {
      type: 'thinking',
      delta: 'turn one',
    });
    state = reduceStreamState(state, { type: 'assistant_start' });
    state = reduceStreamState(state, { type: 'thinking', delta: 'turn two' });

    expect(state.blocks).toEqual([
      { kind: 'thinking', text: 'turn one' },
      { kind: 'thinking', text: 'turn two' },
    ]);
  });

  it('retains structured details when an edit tool finishes', () => {
    let state = reduceStreamState(baseState(), {
      type: 'tool_start',
      id: 'edit_1',
      name: 'edit_file',
      args: { path: 'src/app.ts' },
    });
    state = reduceStreamState(state, {
      type: 'tool_end',
      id: 'edit_1',
      name: 'edit_file',
      isError: false,
      output: 'Edited src/app.ts: replaced 1 occurrence(s).',
      details: {
        path: 'src/app.ts',
        replacements: 1,
        diff: '-1 old\n+1 new',
        patch: '--- src/app.ts\n+++ src/app.ts',
        firstChangedLine: 1,
      },
    });

    expect(state.blocks).toEqual([
      {
        kind: 'tool',
        tool: {
          id: 'edit_1',
          name: 'edit_file',
          args: { path: 'src/app.ts' },
          done: true,
          isError: false,
          output: 'Edited src/app.ts: replaced 1 occurrence(s).',
          details: {
            path: 'src/app.ts',
            replacements: 1,
            diff: '-1 old\n+1 new',
            patch: '--- src/app.ts\n+++ src/app.ts',
            firstChangedLine: 1,
          },
        },
      },
    ]);
  });

  it('keeps partial blocks and run identity when the stream fails', () => {
    const state = reduceStreamState(baseState(), {
      type: 'text',
      delta: 'Partial reply',
    });

    const failed = reduceStreamState(state, {
      type: 'error',
      message: 'OpenAI API error (402)',
    });

    expect(failed).toMatchObject({
      active: false,
      runId: 'run_1',
      terminalError: 'OpenAI API error (402)',
    });
    expect(failed.blocks).toBe(state.blocks);
    expect(failed.blocks).toEqual([{ kind: 'text', text: 'Partial reply' }]);
  });

  it('closes in-flight thinking and pending asks on a terminal error', () => {
    const failed = reduceStreamState(
      {
        ...baseState(),
        thinkingActive: true,
        pendingAsk: { askId: 'ask_1', questions: [question] },
      },
      { type: 'error', message: 'Provider unavailable' },
    );

    expect(failed.active).toBe(false);
    expect(failed.thinkingActive).toBe(false);
    expect(failed.pendingAsk).toBeUndefined();
    expect(failed.terminalError).toBe('Provider unavailable');
  });
});
