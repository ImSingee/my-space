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
});
