import type { AskAnswer, AskQuestion } from './types';

/** Custom text is another choice, so single-choice answers stay exclusive. */
export function updateAskAnswer(
  question: AskQuestion,
  previous: AskAnswer | undefined,
  change: { optionId: string } | { customText: string },
): AskAnswer {
  const answer = previous ?? {
    questionId: question.id,
    selectedOptionIds: [],
    customText: '',
  };
  if ('customText' in change) {
    return {
      ...answer,
      customText: change.customText,
      selectedOptionIds:
        !question.allowMultiple && change.customText.trim()
          ? []
          : answer.selectedOptionIds,
    };
  }
  const selectedOptionIds = answer.selectedOptionIds.includes(change.optionId)
    ? answer.selectedOptionIds.filter((id) => id !== change.optionId)
    : question.allowMultiple
      ? [...answer.selectedOptionIds, change.optionId]
      : [change.optionId];
  return {
    ...answer,
    selectedOptionIds,
    customText: question.allowMultiple ? answer.customText : '',
  };
}
