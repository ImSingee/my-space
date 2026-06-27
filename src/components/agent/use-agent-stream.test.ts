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
    text: '',
    thinking: '',
    thinkingActive: false,
    tools: [],
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
    expect(state.text).toBe('Done.');
  });
});
