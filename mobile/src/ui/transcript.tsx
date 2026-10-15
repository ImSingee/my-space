import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import type { JsonValue, StreamState } from '../core';
import { Card, Text, styles, usePalette } from './primitives';

function record(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}
export function Expandable({
  title,
  text,
  error,
}: {
  title: string;
  text?: string;
  error?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const c = usePalette();
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={{ paddingVertical: 10 }}
      >
        <Text
          style={[
            styles.caption,
            { color: error ? c.danger : c.muted, fontWeight: '600' },
          ]}
        >
          {expanded ? '⌄' : '›'} {title}
        </Text>
      </Pressable>
      {expanded && text ? (
        <Text
          selectable
          style={[styles.caption, { color: c.muted, fontFamily: 'monospace' }]}
        >
          {text}
        </Text>
      ) : null}
    </View>
  );
}
export function TranscriptMessage({ value }: { value: JsonValue }) {
  const c = usePalette();
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
      <Expandable
        title={
          typeof message.toolName === 'string'
            ? message.toolName.replaceAll('_', ' ')
            : 'Tool result'
        }
        text={text}
        error={message.isError === true}
      />
    );
  }
  if (role !== 'user' && role !== 'assistant') return null;
  const displayContent =
    role === 'user' && Array.isArray(message.composerContent)
      ? message.composerContent
      : content;
  return (
    <View
      style={{
        gap: 9,
        paddingVertical: 12,
        paddingHorizontal: role === 'user' ? 16 : 0,
        borderRadius: 18,
        backgroundColor: role === 'user' ? c.subtle : 'transparent',
      }}
    >
      <Text style={[styles.label, { color: c.muted }]}>
        {role === 'user' ? 'YOU' : 'HATCH'}
      </Text>
      {displayContent.map((part, index) => {
        const block = record(part);
        if (!block) return null;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text =
            role === 'user' && Array.isArray(message.attachments)
              ? block.text.replace(
                  /\n*<hatch_attachments>[\s\S]*?<\/hatch_attachments>\s*$/,
                  '',
                )
              : block.text;
          return text ? (
            <Text
              key={index}
              selectable
              style={[styles.body, { color: c.text }]}
            >
              {text}
            </Text>
          ) : null;
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string')
          return (
            <Expandable key={index} title="Reasoning" text={block.thinking} />
          );
        if (block.type === 'toolCall' && typeof block.name === 'string')
          return (
            <Expandable
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
              style={{ width: 200, height: 160, borderRadius: 12 }}
              resizeMode="contain"
            />
          );
        if (block.type === 'app' || block.type === 'workflow')
          return (
            <Text key={index} style={[styles.body, { color: c.accent }]}>
              {typeof block.name === 'string'
                ? block.name
                : 'Referenced resource'}
            </Text>
          );
        return null;
      })}
      {Array.isArray(message.attachments)
        ? message.attachments.map((attachment, index) => (
            <Text key={index} style={[styles.caption, { color: c.muted }]}>
              ↗ {String(record(attachment)?.name ?? 'Attachment')}
            </Text>
          ))
        : null}
      {typeof message.errorMessage === 'string' ? (
        <Text style={{ color: c.danger }}>{message.errorMessage}</Text>
      ) : null}
    </View>
  );
}
export function LiveTranscript({ state }: { state: StreamState }) {
  const c = usePalette();
  return (
    <Card>
      <Text style={[styles.label, { color: c.accent }]}>HATCH</Text>
      {state.blocks.map((block, index) => {
        if (block.kind === 'text')
          return (
            <Text
              key={index}
              selectable
              style={[styles.body, { color: c.text }]}
            >
              {block.text}
            </Text>
          );
        if (block.kind === 'thinking')
          return <Expandable key={index} title="Reasoning" text={block.text} />;
        if (block.kind !== 'tool') return null;
        const tool = state.tools.find((item) => item.id === block.id);
        return tool ? (
          <View key={index} style={{ gap: 8 }}>
            <Expandable
              title={`Request · ${tool.name.replaceAll('_', ' ')}`}
              text={JSON.stringify(tool.args ?? {}, null, 2)}
            />
            <Expandable
              title={`${tool.done ? (tool.isError ? 'Failed' : 'Done') : 'Working'} · ${tool.label ?? tool.name.replaceAll('_', ' ')}`}
              text={tool.output ?? tool.summary}
              error={tool.isError}
            />
          </View>
        ) : null;
      })}
      {!state.blocks.length ? (
        <Text style={[styles.body, { color: c.muted }]}>
          Your Agent is getting started…
        </Text>
      ) : null}
      {state.error ? (
        <Text style={{ color: c.danger }}>{state.error}</Text>
      ) : null}
    </Card>
  );
}
