import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import SegmentedControl from '@expo/ui/community/segmented-control';
import { useSession } from '../state/session';
import {
  Action,
  Busy,
  Notice,
  Text,
  errorText,
  usePalette,
} from '../ui/primitives';
import { NativeField } from '../ui/native-field';
import { ResourceRow } from '../ui/resource-row';
import { Screen, SectionLabel } from '../ui/screen';
import type { AppSummary } from '../core';

export function ResourcesScreen({
  kind = 'apps',
  all = false,
  nested = false,
}: {
  kind?: 'apps' | 'workflows';
  all?: boolean;
  nested?: boolean;
}) {
  const { api, origin } = useSession();
  const c = usePalette();
  const [scope, setScope] = useState(all ? 1 : 0);
  const [search, setSearch] = useState('');
  const resources = useQuery({
    queryKey: [origin, kind],
    queryFn: ({ signal }) =>
      kind === 'apps' ? api!.apps(signal) : api!.workflows(signal),
    enabled: Boolean(api),
  });
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const workflows = useQuery({
    queryKey: [origin, 'workflows'],
    queryFn: ({ signal }) => api!.workflows(signal),
    enabled: Boolean(api) && kind === 'apps' && scope === 0,
  });
  const refresh = () => {
    void resources.refetch();
    void workspace.refetch();
    if (kind === 'apps' && scope === 0) void workflows.refetch();
  };
  const match = (name: string) =>
    name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const available = (resources.data ?? []).filter(
    (item) => item.status !== 'archived',
  );
  const appById = new Map(available.map((item) => [item.id, item]));
  const pins = (workspace.data?.appPins ?? []).filter(
    (pin) => appById.has(pin.appId) && match(pin.label),
  );
  const pinnedWorkflowIds = workspace.data?.pinnedWorkflowIds ?? [];
  const workflowById = new Map(
    (kind === 'workflows' ? available : (workflows.data ?? [])).map((item) => [
      item.id,
      item,
    ]),
  );
  const pinnedWorkflows = pinnedWorkflowIds.flatMap((id) => {
    const item = workflowById.get(id);
    return item && match(item.name) ? [item] : [];
  });
  const rows =
    scope === 1
      ? available.filter((item) => match(item.name))
      : kind === 'workflows'
        ? pinnedWorkflows
        : [];
  const open = (item: AppSummary, resourceKind: 'apps' | 'workflows') =>
    router.push({
      pathname: resourceKind === 'apps' ? '/apps/[id]' : '/workflows/[id]',
      params: { id: item.id },
    });
  const failure =
    resources.error ??
    workspace.error ??
    (kind === 'apps' && scope === 0 ? workflows.error : null);
  const pending =
    resources.isPending ||
    (scope === 0 &&
      (workspace.isPending || (kind === 'apps' && workflows.isPending)));
  const empty =
    scope === 0 && kind === 'apps'
      ? !pins.length && !pinnedWorkflows.length
      : !rows.length;
  const render = (item: AppSummary, resourceKind: 'apps' | 'workflows') => (
    <ResourceRow
      key={item.id}
      title={item.name}
      detail={
        item.description ||
        (item.status === 'deployed' ? 'Ready to open' : item.status)
      }
      kind={resourceKind === 'apps' ? 'app' : 'workflow'}
      onPress={() => open(item, resourceKind)}
    />
  );
  return (
    <Screen
      title={kind === 'apps' ? 'Apps' : 'Workflows'}
      subtitle={
        scope === 0
          ? 'The things you come back to.'
          : 'Everything in your workspace.'
      }
      nested={nested}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 32,
          gap: 16,
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={resources.isRefetching || workspace.isRefetching}
            onRefresh={refresh}
            tintColor={c.accentText}
          />
        }
      >
        <SegmentedControl
          appearance="light"
          values={['Pinned', kind === 'apps' ? 'All apps' : 'All workflows']}
          selectedIndex={scope}
          onChange={({ nativeEvent }) =>
            setScope(nativeEvent.selectedSegmentIndex)
          }
        />
        <NativeField
          label={`Search ${kind}`}
          placeholder={`Search ${scope === 0 ? 'pinned items' : kind}`}
          value={search}
          onChange={setSearch}
        />
        {failure ? (
          <Notice
            title="Couldn’t refresh"
            detail={errorText(failure)}
            action={{ label: 'Try again', onPress: refresh }}
          />
        ) : null}
        {pending ? (
          <Busy label="Loading your workspace…" />
        ) : empty && !failure ? (
          <View style={{ paddingVertical: 40, gap: 12 }}>
            <Text style={{ fontSize: 23, fontWeight: '600', color: c.text }}>
              {search
                ? 'No matches'
                : scope === 0
                  ? 'Keep your favorites close'
                  : `Your ${kind} start here`}
            </Text>
            <Text style={{ color: c.muted, fontSize: 16, lineHeight: 24 }}>
              {search
                ? 'Try another name.'
                : scope === 0
                  ? 'Pin apps and workflows in Hatch on the web. Your favorites will be ready here.'
                  : 'Create something with your Agent, then find it here.'}
            </Text>
            {!search && scope === 0 ? (
              <Action
                secondary
                label={`Browse all ${kind}`}
                onPress={() => setScope(1)}
              />
            ) : null}
          </View>
        ) : null}
        {scope === 0 && kind === 'apps' ? (
          <View>
            {pins.length ? (
              <>
                <SectionLabel>Apps</SectionLabel>
                {pins.map((pin) => (
                  <ResourceRow
                    key={pin.id}
                    title={pin.label}
                    detail={appById.get(pin.appId)?.description || 'Open app'}
                    kind="app"
                    onPress={() =>
                      router.push({
                        pathname: '/apps/[id]',
                        params: {
                          id: pin.appId,
                          entryHash: pin.entryHash,
                          label: pin.label,
                        },
                      })
                    }
                  />
                ))}
              </>
            ) : null}
            {pinnedWorkflows.length ? (
              <>
                <SectionLabel>Workflows</SectionLabel>
                {pinnedWorkflows.map((item) => render(item, 'workflows'))}
              </>
            ) : null}
          </View>
        ) : (
          <View>{rows.map((item) => render(item, kind))}</View>
        )}
      </ScrollView>
    </Screen>
  );
}
