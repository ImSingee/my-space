import { NativeField, type NativeFieldRef } from './native-field';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { AskAnswer, PendingAsk } from '../core';
import { updateAskAnswer } from '../core/ask-answer';
import { Button } from './button';
import { Glyph } from './glyph';
import { Card, Tag } from './primitives';
import { Text, type } from './text';
import { palette as c } from './theme';

function OptionRow({
  label,
  multiple,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  multiple: boolean;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: selected ? c.moss : c.rule,
        backgroundColor: selected ? c.limeSoft : pressed ? c.paper : c.card,
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: multiple ? 7 : 11,
          borderWidth: selected ? 0 : 1.5,
          borderColor: c.inkFaint,
          backgroundColor: selected ? c.moss : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {selected ? (
          multiple ? (
            <Glyph name="check" size={12} color={c.onMoss} />
          ) : (
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: c.lime,
              }}
            />
          )
        ) : null}
      </View>
      <Text style={[type.body, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

export function AskCard({
  ask,
  onAnswer,
  busy,
}: {
  ask: PendingAsk;
  onAnswer: (answers: AskAnswer[]) => void;
  busy: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, AskAnswer>>({});
  const fields = useRef<Record<string, NativeFieldRef | null>>({});
  const get = (id: string): AskAnswer =>
    answers[id] ?? { questionId: id, selectedOptionIds: [], customText: '' };
  return (
    <Card style={{ borderWidth: 2, borderColor: c.lime, gap: 16 }}>
      <Tag tone="lime" glyph="question" label="Your Agent asks" />
      {ask.questions.map((question) => (
        <View key={question.id} style={{ gap: 10 }}>
          <Text accessibilityRole="header" style={type.heading}>
            {question.prompt}
          </Text>
          {question.allowMultiple ? (
            <Text style={type.meta}>Choose any that apply</Text>
          ) : null}
          <View
            accessibilityRole={
              question.allowMultiple ? undefined : 'radiogroup'
            }
            style={{ gap: 8 }}
          >
            {question.options.map((option) => {
              const selected = get(question.id).selectedOptionIds.includes(
                option.id,
              );
              return (
                <OptionRow
                  key={option.id}
                  label={option.label}
                  multiple={question.allowMultiple}
                  selected={selected}
                  disabled={busy}
                  onPress={() => {
                    // A radio stays selected when tapped again.
                    if (selected && !question.allowMultiple) return;
                    setAnswers((value) => ({
                      ...value,
                      [question.id]: updateAskAnswer(
                        question,
                        value[question.id],
                        { optionId: option.id },
                      ),
                    }));
                  }}
                />
              );
            })}
          </View>
          <NativeField
            ref={(field) => {
              fields.current[question.id] = field;
            }}
            label={`Other answer: ${question.prompt}`}
            placeholder={
              question.options.length
                ? 'Or write your own answer…'
                : 'Write your answer…'
            }
            value={get(question.id).customText ?? ''}
            unavailable={busy}
            multiline
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
      <Button
        fullWidth
        glyph="send"
        label={busy ? 'Sending answer…' : 'Send answer'}
        busy={busy}
        disabled={ask.questions.some(
          (question) =>
            !get(question.id).selectedOptionIds.length &&
            !get(question.id).customText?.trim(),
        )}
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
