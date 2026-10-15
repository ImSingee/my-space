import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { AskAnswer, PendingAsk } from '../core';
import {
  Action,
  Card,
  Text,
  TextInput,
  styles,
  usePalette,
} from './primitives';

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
          {question.options.map((option) => {
            const selected = get(question.id).selectedOptionIds.includes(
              option.id,
            );
            return (
              <Pressable
                key={option.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => {
                  const previous = get(question.id);
                  const selectedOptionIds = selected
                    ? previous.selectedOptionIds.filter(
                        (id) => id !== option.id,
                      )
                    : question.allowMultiple
                      ? [...previous.selectedOptionIds, option.id]
                      : [option.id];
                  setAnswers((value) => ({
                    ...value,
                    [question.id]: { ...previous, selectedOptionIds },
                  }));
                }}
                style={{
                  minHeight: 46,
                  padding: 13,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: selected ? c.accent : c.border,
                  backgroundColor: selected ? c.subtle : c.card,
                }}
              >
                <Text style={{ color: c.text }}>
                  {selected ? '✓  ' : ''}
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
          <TextInput
            accessibilityLabel={`Other answer: ${question.prompt}`}
            placeholder="Or write your own answer…"
            placeholderTextColor={c.muted}
            value={get(question.id).customText}
            editable={!busy}
            onChangeText={(customText) =>
              setAnswers((value) => ({
                ...value,
                [question.id]: { ...get(question.id), customText },
              }))
            }
            style={[styles.input, { color: c.text, borderColor: c.border }]}
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
          onAnswer(ask.questions.map((question) => get(question.id)))
        }
      />
    </Card>
  );
}
