import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { Button } from '../../src/ui/button';
import { Busy, Card, Notice, Tag, errorText } from '../../src/ui/primitives';
import { GlyphTile } from '../../src/ui/rows';
import { Masthead, SectionLabel } from '../../src/ui/screen';
import { StatusTag, statusText } from '../../src/ui/status';
import { Text, type } from '../../src/ui/text';
import { palette as c } from '../../src/ui/theme';

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function WorkflowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin } = useSession();
  const [problem, setProblem] = useState<string | null>(null);
  const query = useQuery({
    queryKey: [origin, 'workflow', id],
    queryFn: ({ signal }) => api!.workflow(id, signal),
    enabled: Boolean(api),
  });
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const data = query.data;
  const pinned = workspace.data?.pinnedWorkflowIds.includes(id) ?? false;
  if (query.error)
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.paper }}>
        <Notice
          tone="danger"
          title="Couldn’t load this workflow"
          detail={errorText(query.error)}
          action={{ label: 'Try again', onPress: () => void query.refetch() }}
        />
      </View>
    );
  if (!data) return <Busy label="Loading workflow" />;
  const facts = [
    ['Status', statusText(data.status)],
    ['Handle', data.slug],
    ['Updated', when(data.updatedAt)],
    ['Created', when(data.createdAt)],
  ];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.paper }}
      contentContainerStyle={{ paddingBottom: 56 }}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={c.moss}
        />
      }
    >
      <Masthead nested eyebrow="Workflow" title={data.name} />
      <View style={{ paddingHorizontal: 20, gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <StatusTag status={data.status} />
          {pinned ? <Tag tone="outline" glyph="pin" label="Pinned" /> : null}
        </View>
        <Text style={[type.body, { color: c.inkSoft }]}>
          {data.description ||
            'An automation that runs on your Hatch instance.'}
        </Text>
      </View>
      <View style={{ paddingHorizontal: 16 }}>
        <SectionLabel>At a glance</SectionLabel>
        <Card style={{ gap: 0, paddingVertical: 6 }}>
          {facts.map(([label, value], index) => (
            <View
              key={label}
              accessible
              accessibilityLabel={`${label}: ${value}`}
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                gap: 12,
                paddingVertical: 12,
                borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                borderTopColor: c.rule,
              }}
            >
              <Text style={[type.meta, { paddingTop: 2 }]}>{label}</Text>
              <Text
                selectable
                style={[type.body, { flexShrink: 1, textAlign: 'right' }]}
              >
                {value}
              </Text>
            </View>
          ))}
        </Card>
        <SectionLabel>Runs on your instance</SectionLabel>
        <Card>
          <View
            style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}
          >
            <GlyphTile glyph="workflows" tone="lime" size={36} />
            <Text style={[type.callout, { flex: 1 }]}>
              Triggers, run history and settings are managed in Hatch on the
              web. This phone shows what you have and where it stands.
            </Text>
          </View>
          <Button
            variant="secondary"
            glyph="browser"
            label="Open in Hatch web"
            fullWidth
            onPress={() => {
              setProblem(null);
              void WebBrowser.openBrowserAsync(
                `${origin}/workflow/${encodeURIComponent(data.slug)}`,
              ).catch((error: unknown) => setProblem(errorText(error)));
            }}
          />
          {problem ? (
            <Text
              accessibilityRole="alert"
              style={[type.small, { color: c.danger }]}
            >
              {problem}
            </Text>
          ) : null}
        </Card>
      </View>
    </ScrollView>
  );
}
