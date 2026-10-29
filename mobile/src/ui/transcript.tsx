import { useEffect, useState } from 'react';
import { Animated, Easing, Image, View } from 'react-native';
import type { JsonValue, StreamState } from '../core';
import { Details } from './details';
import { Glyph } from './glyph';
import { Egg, useReducedMotion } from './primitives';
import { Text, type } from './text';
import { palette as c } from './theme';

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function Speaker({ live }: { live?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Egg size={11} wobble={live} />
      <Text style={[type.meta, { color: c.ink }]}>Hatch</Text>
    </View>
  );
}

export function TranscriptMessage({ value }: { value: JsonValue }) {
  const message = record(value);
  if (!message || typeof message.role !== 'string') return null;
  const role = message.role;
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: message.content }];
  if (role === 'toolResult') {
    const text = content
      .map((part) => record(part)?.text)
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    return (
      <View style={{ paddingLeft: 19 }}>
        <Details
          title={
            typeof message.toolName === 'string'
              ? `Result · ${message.toolName.replaceAll('_', ' ')}`
              : 'Tool result'
          }
          text={text}
          error={message.isError === true}
          state={message.isError === true ? 'failed' : 'done'}
        />
      </View>
    );
  }
  if (role !== 'user' && role !== 'assistant') return null;
  const mine = role === 'user';
  const displayContent =
    mine && Array.isArray(message.composerContent)
      ? message.composerContent
      : content;
  const ink = mine ? c.card : c.ink;
  return (
    <View
      style={
        mine
          ? {
              alignSelf: 'flex-end',
              maxWidth: '88%',
              backgroundColor: c.ink,
              borderRadius: 22,
              borderBottomRightRadius: 6,
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 8,
            }
          : { alignSelf: 'stretch', gap: 10, paddingVertical: 4 }
      }
    >
      {mine ? null : <Speaker />}
      {displayContent.map((part, index) => {
        const block = record(part);
        if (!block) return null;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text =
            mine && Array.isArray(message.attachments)
              ? block.text.replace(
                  /\n*<hatch_attachments>[\s\S]*?<\/hatch_attachments>\s*$/,
                  '',
                )
              : block.text;
          return text ? (
            <Text
              key={index}
              selectable
              style={[type.body, { color: ink, lineHeight: 24 }]}
            >
              {text}
            </Text>
          ) : null;
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string')
          return (
            <Details key={index} title="Reasoning" text={block.thinking} />
          );
        if (block.type === 'toolCall' && typeof block.name === 'string')
          return (
            <Details
              key={index}
              title={`Request · ${block.name.replaceAll('_', ' ')}`}
              text={JSON.stringify(block.arguments ?? {}, null, 2)}
            />
          );
        if (block.type === 'image' && typeof block.data === 'string')
          return (
            <Image
              key={index}
              accessibilityLabel="Attached image"
              source={{
                uri: `data:${typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg'};base64,${block.data}`,
              }}
              style={{ width: 200, height: 160, borderRadius: 14 }}
              resizeMode="cover"
            />
          );
        if (block.type === 'app' || block.type === 'workflow')
          return (
            <View
              key={index}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Glyph
                name={block.type === 'app' ? 'apps' : 'workflows'}
                size={13}
                color={mine ? c.lime : c.moss}
              />
              <Text style={[type.callout, { color: mine ? c.lime : c.moss }]}>
                {typeof block.name === 'string'
                  ? block.name
                  : 'Referenced resource'}
              </Text>
            </View>
          );
        return null;
      })}
      {Array.isArray(message.attachments)
        ? message.attachments.map((attachment, index) => (
            <View
              key={index}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Glyph
                name="attach"
                size={12}
                color={mine ? c.lime : c.inkSoft}
              />
              <Text
                style={[type.small, { color: mine ? c.card : c.inkSoft }]}
                numberOfLines={1}
              >
                {String(record(attachment)?.name ?? 'Attachment')}
              </Text>
            </View>
          ))
        : null}
      {typeof message.errorMessage === 'string' ? (
        <Text style={[type.small, { color: mine ? c.lime : c.danger }]}>
          {message.errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

function WorkingDots() {
  const reduced = useReducedMotion();
  const [phase] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(phase, {
        toValue: 3,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, reduced]);
  return (
    <View style={{ flexDirection: 'row', gap: 5 }} accessible={false}>
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={index}
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: c.moss,
            opacity: reduced
              ? 0.6
              : phase.interpolate({
                  inputRange: [index, index + 0.5, index + 1, 3].map((v) =>
                    Math.min(v, 3),
                  ),
                  outputRange: [0.25, 1, 0.25, 0.25],
                  extrapolate: 'clamp',
                }),
          }}
        />
      ))}
    </View>
  );
}

export function LiveTranscript({
  state,
  status,
}: {
  state: StreamState;
  status: string;
}) {
  return (
    <View style={{ gap: 10, paddingVertical: 4 }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={status}
      >
        <Speaker live />
        <WorkingDots />
        <Text style={[type.meta, { flex: 1 }]} numberOfLines={2}>
          {status}
        </Text>
      </View>
      {state.blocks.map((block, index) => {
        if (block.kind === 'text')
          return (
            <Text
              key={index}
              selectable
              style={[type.body, { lineHeight: 24 }]}
            >
              {block.text}
            </Text>
          );
        if (block.kind === 'thinking')
          return <Details key={index} title="Reasoning" text={block.text} />;
        if (block.kind !== 'tool') return null;
        const tool = state.tools.find((item) => item.id === block.id);
        return tool ? (
          <View key={index} style={{ gap: 6 }}>
            <Details
              title={`Request · ${tool.name.replaceAll('_', ' ')}`}
              text={JSON.stringify(tool.args ?? {}, null, 2)}
            />
            <Details
              title={`${tool.done ? (tool.isError ? 'Failed' : 'Done') : 'Working'} · ${tool.label ?? tool.name.replaceAll('_', ' ')}`}
              text={tool.output ?? tool.summary}
              error={tool.isError}
              state={!tool.done ? 'working' : tool.isError ? 'failed' : 'done'}
            />
          </View>
        ) : null;
      })}
      {!state.blocks.length ? (
        <Text style={type.callout}>Your Agent is getting started…</Text>
      ) : null}
      {state.error ? (
        <Text style={[type.small, { color: c.danger }]}>{state.error}</Text>
      ) : null}
    </View>
  );
}
