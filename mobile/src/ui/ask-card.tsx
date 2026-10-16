import { Choice, OptionToggle } from './native-controls';
import { NativeField, type NativeFieldRef } from './native-field';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import type { AskAnswer, PendingAsk } from '../core';
import { updateAskAnswer } from '../core/ask-answer';
import { Action, Card, Text, styles, usePalette } from './primitives';

export function AskCard({
  ask,
  onAnswer,
  busy,
}: {
  ask: PendingAsk;
  onAnswer: (answers: AskAnswer[]) => void;
  busy: boolean;
}) {
  const c = usePalette();
  const [answers, setAnswers] = useState<Record<string, AskAnswer>>({});
  const fields = useRef<Record<string, NativeFieldRef | null>>({});
  const get = (id: string): AskAnswer =>
    answers[id] ?? { questionId: id, selectedOptionIds: [], customText: '' };
  return (
    <Card>
      <Text style={[styles.label, { color: c.accent }]}>
        YOUR AGENT HAS A QUESTION
      </Text>
      {ask.questions.map((question) => (
        <View key={question.id} style={{ gap: 10 }}>
          <Text style={[styles.body, { color: c.text, fontWeight: '600' }]}>
            {question.prompt}
          </Text>
          {question.allowMultiple ? (
            question.options.map((option) => (
              <OptionToggle
                key={option.id}
                label={option.label}
                selected={get(question.id).selectedOptionIds.includes(
                  option.id,
                )}
                unavailable={busy}
                onChange={() =>
                  setAnswers((value) => ({
                    ...value,
                    [question.id]: updateAskAnswer(
                      question,
                      value[question.id],
                      { optionId: option.id },
                    ),
                  }))
                }
              />
            ))
          ) : question.options.length ? (
            <Choice
              label="Choose an answer"
              value={get(question.id).selectedOptionIds[0] ?? ''}
              options={[
                { label: 'Choose an option or write below', value: '' },
                ...question.options.map((option) => ({
                  label: option.label,
                  value: option.id,
                })),
              ]}
              disabled={busy}
              onChange={(optionId) => {
                if (optionId)
                  setAnswers((value) => ({
                    ...value,
                    [question.id]: updateAskAnswer(
                      question,
                      value[question.id],
                      { optionId },
                    ),
                  }));
              }}
            />
          ) : null}
          <NativeField
            ref={(field) => {
              fields.current[question.id] = field;
            }}
            label={`Other answer: ${question.prompt}`}
            placeholder="Or write your own answer…"
            value={get(question.id).customText ?? ''}
            unavailable={busy}
            onChange={(customText) =>
              setAnswers((value) => ({
                ...value,
                [question.id]: updateAskAnswer(question, value[question.id], {
                  customText,
                }),
              }))
            }
          />
        </View>
      ))}
      <Action
        label={busy ? 'Sending answer…' : 'Send answer'}
        disabled={
          busy ||
          ask.questions.some(
            (question) =>
              !get(question.id).selectedOptionIds.length &&
              !get(question.id).customText?.trim(),
          )
        }
        onPress={() =>
          onAnswer(
            ask.questions.map((question) =>
              updateAskAnswer(question, get(question.id), {
                customText:
                  fields.current[question.id]?.getText() ??
                  get(question.id).customText ??
                  '',
              }),
            ),
          )
        }
      />
    </Card>
  );
}
