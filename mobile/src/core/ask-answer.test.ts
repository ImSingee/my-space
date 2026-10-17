import { describe, expect, it } from 'vitest';
import { updateAskAnswer } from './ask-answer';
import type { AskQuestion } from './types';

const question: AskQuestion = {
  id: 'q1',
  prompt: 'Choose a colour',
  options: [
    { id: 'o1', label: 'Blue' },
    { id: 'o2', label: 'Green' },
  ],
  allowMultiple: false,
};

describe('native question answers', () => {
  it('keeps one choice when switching between a preset and Other in either direction', () => {
    let answer = updateAskAnswer(question, undefined, { optionId: 'o1' });
    answer = updateAskAnswer(question, answer, { customText: 'Orange' });
    expect(answer).toEqual({
      questionId: 'q1',
      selectedOptionIds: [],
      customText: 'Orange',
    });
    answer = updateAskAnswer(question, answer, { optionId: 'o2' });
    expect(answer).toEqual({
      questionId: 'q1',
      selectedOptionIds: ['o2'],
      customText: '',
    });
  });

  it('does not discard a selected choice for an empty Other answer', () => {
    const selected = updateAskAnswer(question, undefined, { optionId: 'o1' });
    expect(
      updateAskAnswer(question, selected, { customText: '  ' })
        .selectedOptionIds,
    ).toEqual(['o1']);
  });

  it('preserves combined presets and Other for multiple-choice questions', () => {
    const multiple = { ...question, allowMultiple: true };
    let answer = updateAskAnswer(multiple, undefined, { optionId: 'o1' });
    answer = updateAskAnswer(multiple, answer, { customText: 'Orange' });
    answer = updateAskAnswer(multiple, answer, { optionId: 'o2' });
    answer = updateAskAnswer(multiple, answer, { optionId: 'o1' });
    expect(answer).toEqual({
      questionId: 'q1',
      selectedOptionIds: ['o2'],
      customText: 'Orange',
    });
  });
});
