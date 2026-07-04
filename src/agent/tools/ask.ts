/** The `ask` tool: surface multiple-choice questions to the user and block. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AskAnswer, AskQuestion } from '../events';
import { text, tool } from './shared';

/**
 * Bridge supplied by the runtime so the `ask` tool can surface a question to the
 * chat UI and block until the user replies. Resolves with the user's answers.
 */
export type AskBridge = (
  questions: AskQuestion[],
  signal?: AbortSignal,
) => Promise<AskAnswer[]>;

/** Render the user's answers as readable text for the model to consume. */
function formatAskAnswers(
  questions: AskQuestion[],
  answers: AskAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const lines = questions.map((q) => {
    const answer = byId.get(q.id);
    const labels = (answer?.selectedOptionIds ?? [])
      .map((oid) => q.options.find((o) => o.id === oid)?.label)
      .filter((label): label is string => Boolean(label));
    if (answer?.customText) labels.push(answer.customText.trim());
    const value = labels.length > 0 ? labels.join(', ') : '(no answer)';
    return `Q: ${q.prompt}\nA: ${value}`;
  });
  return lines.join('\n\n');
}

export function createAskTool(askBridge: AskBridge): AgentTool {
  return tool({
    name: 'ask',
    label: 'Ask the user',
    description:
      'Ask the user a multiple-choice question when you are blocked on a ' +
      'decision only they can make — ambiguous requirements, a trade-off ' +
      'between approaches, or missing information you cannot infer. Prefer ' +
      'this over guessing for consequential choices, but do NOT use it for ' +
      'things you can reasonably decide yourself. Each question needs at ' +
      'least two options; the user can also type a custom answer. Returns the ' +
      "user's selections so you can continue.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          prompt: Type.String({ description: 'The question to ask.' }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                description: 'A choice the user can pick.',
              }),
            }),
            { description: 'Two or more options.' },
          ),
          allowMultiple: Type.Optional(
            Type.Boolean({
              description: 'Allow selecting more than one option.',
            }),
          ),
        }),
        { description: 'One or more questions to ask at once.' },
      ),
    }),
    execute: async (_id, params, signal) => {
      if (params.questions.length === 0) {
        throw new Error('Provide at least one question.');
      }
      const questions: AskQuestion[] = params.questions.map((q, qi) => ({
        id: `q${qi + 1}`,
        prompt: q.prompt,
        options: q.options.map((o, oi) => ({
          id: `o${oi + 1}`,
          label: o.label,
        })),
        allowMultiple: q.allowMultiple ?? false,
      }));
      const answers = await askBridge(questions, signal);
      return text(formatAskAnswers(questions, answers), { questions, answers });
    },
  });
}
