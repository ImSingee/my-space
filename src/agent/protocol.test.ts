import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  isSafeRelativePath,
  parseHubMessage,
  parseRunnerMessage,
  scaffoldFileSchema,
} from './protocol';

describe('runner -> platform messages', () => {
  it('parses runner.hello', () => {
    const message = parseRunnerMessage({
      type: 'runner.hello',
      runnerId: 'runner-1',
      protocolVersion: 1,
      activeRunIds: ['a', 'b'],
    });
    if (message.type !== 'runner.hello') throw new Error('wrong type');
    expect(message.activeRunIds).toEqual(['a', 'b']);
  });

  it('parses run.event and preserves the stream payload', () => {
    const message = parseRunnerMessage({
      type: 'run.event',
      runId: 'r1',
      runnerSeq: 7,
      event: { type: 'text', delta: 'hi' },
    });
    if (message.type !== 'run.event') throw new Error('wrong type');
    expect(message.runnerSeq).toBe(7);
    expect(message.event).toEqual({ type: 'text', delta: 'hi' });
  });

  it('parses run.finished with and without error', () => {
    const ok = parseRunnerMessage({
      type: 'run.finished',
      runId: 'r1',
      status: 'completed',
      messages: [{ role: 'assistant' }],
    });
    if (ok.type !== 'run.finished') throw new Error('wrong type');
    expect(ok.error).toBeUndefined();

    const failed = parseRunnerMessage({
      type: 'run.finished',
      runId: 'r1',
      status: 'failed',
      error: 'boom',
      messages: [],
    });
    if (failed.type !== 'run.finished') throw new Error('wrong type');
    expect(failed.error).toBe('boom');
  });

  it('rejects unknown message types and bad payloads', () => {
    expect(() => parseRunnerMessage({ type: 'nope' })).toThrow(ZodError);
    expect(() =>
      parseRunnerMessage({ type: 'run.event', runId: '', runnerSeq: 1 }),
    ).toThrow(ZodError);
    expect(() =>
      parseRunnerMessage({
        type: 'run.event',
        runId: 'r1',
        runnerSeq: 0, // must be positive
        event: { type: 'text', delta: 'x' },
      }),
    ).toThrow(ZodError);
  });
});

describe('platform -> runner messages', () => {
  it('parses run.start with model config', () => {
    const message = parseHubMessage({
      type: 'run.start',
      runId: 'r1',
      sessionId: 's1',
      userText: 'hello',
      images: [],
      priorMessages: [],
      model: {
        providerId: 'p1',
        providerName: 'Test',
        apiType: 'anthropic-messages',
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        model: {
          id: 'm1',
          name: 'Model One',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      },
    });
    if (message.type !== 'run.start') throw new Error('wrong type');
    expect(message.model.model.id).toBe('m1');
  });

  it('parses run.answer and defaults selectedOptionIds', () => {
    const message = parseHubMessage({
      type: 'run.answer',
      runId: 'r1',
      askId: 'ask1',
      answers: [{ questionId: 'q1', customText: 'free text' }],
    });
    if (message.type !== 'run.answer') throw new Error('wrong type');
    expect(message.answers[0].selectedOptionIds).toEqual([]);
    expect(message.answers[0].customText).toBe('free text');
  });

  it('rejects a runner message on the hub channel', () => {
    expect(() => parseHubMessage({ type: 'runner.ping' })).toThrow(ZodError);
  });
});

describe('scaffold file safety', () => {
  it('accepts normal relative paths', () => {
    expect(isSafeRelativePath('manifest.json')).toBe(true);
    expect(isSafeRelativePath('app/src/main.tsx')).toBe(true);
    expect(isSafeRelativePath('.gitignore')).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('../outside')).toBe(false);
    expect(isSafeRelativePath('a/../../outside')).toBe(false);
    expect(isSafeRelativePath('a/./b')).toBe(false);
    expect(isSafeRelativePath('a//b')).toBe(false);
    expect(isSafeRelativePath('a\\b')).toBe(false);
    expect(isSafeRelativePath('a\0b')).toBe(false);
  });

  it('scaffoldFileSchema enforces the path check', () => {
    expect(
      scaffoldFileSchema.safeParse({ path: '../x', contentBase64: '' }).success,
    ).toBe(false);
    expect(
      scaffoldFileSchema.safeParse({ path: 'x.txt', contentBase64: 'aGk=' })
        .success,
    ).toBe(true);
  });
});
