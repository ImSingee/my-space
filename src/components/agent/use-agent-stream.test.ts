import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '~agent/events';
import {
  reduceStreamState,
  sameStreamSeed,
  type StreamState,
} from './use-agent-stream';

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
  it('shows an env request and replaces an existing ask', () => {
    const state = reduceStreamState(
      {
        ...baseState(),
        pendingAsk: { askId: 'ask_1', questions: [question] },
      },
      {
        type: 'env_request',
        requestId: 'env_1',
        reason: 'Connect to GitHub',
        variables: [
          {
            key: 'GITHUB_TOKEN',
            description: 'Repository access token',
            secret: true,
          },
        ],
      },
    );

    expect(state.pendingAsk).toBeUndefined();
    expect(state.pendingEnvRequest).toEqual({
      requestId: 'env_1',
      reason: 'Connect to GitHub',
      variables: [
        {
          key: 'GITHUB_TOKEN',
          description: 'Repository access token',
          secret: true,
        },
      ],
    });
  });

  it('clears only the matching env request', () => {
    const pendingEnvRequest = {
      requestId: 'env_2',
      reason: 'Connect to GitHub',
      variables: [
        { key: 'GITHUB_TOKEN', description: 'Access token', secret: true },
      ],
    };
    const withOldConfirmation = reduceStreamState(
      { ...baseState(), pendingEnvRequest },
      {
        type: 'env_stored',
        requestId: 'env_1',
        variables: [{ key: 'GITHUB_TOKEN', secret: true }],
      },
    );
    expect(withOldConfirmation.pendingEnvRequest).toBe(pendingEnvRequest);

    const stored = reduceStreamState(withOldConfirmation, {
      type: 'env_stored',
      requestId: 'env_2',
      variables: [{ key: 'GITHUB_TOKEN', secret: true }],
    });
    expect(stored.pendingEnvRequest).toBeUndefined();
  });

  it('replaces a pending env request with a newer ask', () => {
    const state = reduceStreamState(
      {
        ...baseState(),
        pendingEnvRequest: {
          requestId: 'env_1',
          reason: 'Connect to GitHub',
          variables: [
            { key: 'GITHUB_TOKEN', description: 'Access token', secret: true },
          ],
        },
      },
      { type: 'ask', askId: 'ask_1', questions: [question] },
    );

    expect(state.pendingEnvRequest).toBeUndefined();
    expect(state.pendingAsk?.askId).toBe('ask_1');
  });

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

  it('closes in-flight thinking and pending prompts on a terminal error', () => {
    const failed = reduceStreamState(
      {
        ...baseState(),
        thinkingActive: true,
        pendingAsk: { askId: 'ask_1', questions: [question] },
        pendingEnvRequest: {
          requestId: 'env_1',
          reason: 'Connect to GitHub',
          variables: [
            { key: 'GITHUB_TOKEN', description: 'Access token', secret: true },
          ],
        },
      },
      { type: 'error', message: 'Provider unavailable' },
    );

    expect(failed.active).toBe(false);
    expect(failed.thinkingActive).toBe(false);
    expect(failed.pendingAsk).toBeUndefined();
    expect(failed.pendingEnvRequest).toBeUndefined();
    expect(failed.terminalError).toBe('Provider unavailable');
  });
});

describe('sameStreamSeed', () => {
  it('treats refetched safe prompt metadata as the same seed', () => {
    const left = {
      pendingAsk: null,
      pendingEnvRequest: {
        requestId: 'env_1',
        reason: 'Connect to GitHub',
        variables: [
          { key: 'GITHUB_TOKEN', description: 'Access token', secret: true },
        ],
      },
    };

    expect(sameStreamSeed(left, structuredClone(left))).toBe(true);
    expect(
      sameStreamSeed(left, {
        ...left,
        pendingEnvRequest: {
          ...left.pendingEnvRequest,
          requestId: 'env_2',
        },
      }),
    ).toBe(false);
  });
});
