import { useQuery } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, useWindowDimensions, View } from 'react-native';
import { useSession } from '../state/session';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { Busy, EmptyState, Notice, Tag, errorText } from '../ui/primitives';
import { NativeField } from '../ui/native-field';
import { GlyphTile, Group, IndexRow, ListRow, PinTile } from '../ui/rows';
import { ScopeTabs } from '../ui/scope-tabs';
import { ScrollScreen, SectionLabel } from '../ui/screen';
import { StatusTag } from '../ui/status';
import { palette as c } from '../ui/theme';
import type { AppSummary } from '../core';

type Scope = 'pinned' | 'all';

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
  const focused = useIsFocused();
  const { fontScale, width } = useWindowDimensions();
  const [scope, setScope] = useState<Scope>(all ? 'all' : 'pinned');
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
    // Pinned counts include workflows even while the complete list is shown.
    enabled: Boolean(api) && kind === 'apps',
  });
  const refresh = () =>
    Promise.all([
      resources.refetch(),
      workspace.refetch(),
      ...(kind === 'apps' && scope === 'pinned' ? [workflows.refetch()] : []),
    ]);
  const pull = usePullToRefresh(focused, refresh);
  const match = (name: string) =>
    name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const available = (resources.data ?? []).filter(
    (item) => item.status !== 'archived',
  );
  const appById = new Map(available.map((item) => [item.id, item]));
  const allPins = (workspace.data?.appPins ?? []).filter((pin) =>
    appById.has(pin.appId),
  );
  const pins = allPins.filter((pin) => match(pin.label));
  const pinnedWorkflowIds = workspace.data?.pinnedWorkflowIds ?? [];
  const workflowById = new Map(
    (kind === 'workflows' ? available : (workflows.data ?? [])).map((item) => [
      item.id,
      item,
    ]),
  );
  const allPinnedWorkflows = pinnedWorkflowIds.flatMap((id) => {
    const item = workflowById.get(id);
    return item ? [item] : [];
  });
  const pinnedWorkflows = allPinnedWorkflows.filter((item) => match(item.name));
  const rows = available.filter((item) => match(item.name));
  const pinCount =
    kind === 'apps'
      ? allPins.length + allPinnedWorkflows.length
      : allPinnedWorkflows.length;
  const pinsByApp = new Map<string, number>();
  for (const pin of allPins)
    pinsByApp.set(pin.appId, (pinsByApp.get(pin.appId) ?? 0) + 1);
  const failure =
    resources.error ??
    workspace.error ??
    (kind === 'apps' && scope === 'pinned' ? workflows.error : null);
  const pending =
    resources.isPending ||
    (scope === 'pinned' &&
      (workspace.isPending || (kind === 'apps' && workflows.isPending)));
  const empty =
    scope === 'pinned'
      ? kind === 'apps'
        ? !pins.length && !pinnedWorkflows.length
        : !pinnedWorkflows.length
      : !rows.length;
  const columns = fontScale > 1.3 ? 1 : 2;
  const tileWidth = (width - 32 - 10 * (columns - 1)) / columns;
  const pinRows: (typeof pins)[] = [];
  for (let index = 0; index < pins.length; index += columns)
    pinRows.push(pins.slice(index, index + columns));
  const open = (item: AppSummary, resourceKind: 'apps' | 'workflows') =>
    router.push({
      pathname: resourceKind === 'apps' ? '/apps/[id]' : '/workflows/[id]',
      params:
        resourceKind === 'apps'
          ? { id: item.id, slug: item.slug }
          : { id: item.id },
    });
  const noun = kind === 'apps' ? 'Apps' : 'Workflows';
  return (
    <ScrollScreen
      eyebrow={
        resources.data
          ? `${kind === 'apps' ? 'Collection' : 'Automations'} · ${available.length} total`
          : kind === 'apps'
            ? 'Collection'
            : 'Automations'
      }
      title={noun}
      nested={nested}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={c.moss}
        />
      }
    >
      <ScopeTabs<Scope>
        label={`${noun} scope`}
        value={scope}
        onChange={setScope}
        options={[
          { value: 'pinned', label: 'Pinned', count: pinCount },
          {
            value: 'all',
            label: `All ${kind}`,
            count: resources.data ? available.length : undefined,
          },
        ]}
      />
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        <NativeField
          variant="search"
          label={`Search ${scope === 'pinned' ? 'pinned items' : kind}`}
          placeholder={
            scope === 'pinned' ? 'Search pinned' : `Search all ${kind}`
          }
          value={search}
          onChange={setSearch}
        />
        {failure ? (
          <View style={{ marginTop: 16 }}>
            <Notice
              tone="danger"
              title="Couldn’t refresh"
              detail={errorText(failure)}
              action={{ label: 'Try again', onPress: refresh }}
            />
          </View>
        ) : null}
        {pending ? (
          <Busy label={`Gathering ${kind}`} />
        ) : empty && !failure ? (
          <EmptyState
            title={
              search
                ? 'Nothing by that name'
                : scope === 'pinned'
                  ? 'Keep your regulars here'
                  : `No ${kind} yet`
            }
            detail={
              search
                ? 'Try a shorter or different name.'
                : scope === 'pinned'
                  ? `Pin ${kind} in Hatch on the web. Each pin keeps its own name and starting point.`
                  : kind === 'apps'
                    ? 'Ask your Agent to build something, then find it here.'
                    : 'Workflows you create on your instance will appear here.'
            }
            action={
              !search && scope === 'pinned'
                ? {
                    label: `Browse all ${kind}`,
                    onPress: () => setScope('all'),
                  }
                : undefined
            }
          />
        ) : null}
        {pending ? null : scope === 'pinned' ? (
          <>
            {kind === 'apps' && pins.length ? (
              <>
                <SectionLabel count={pins.length}>Pinned apps</SectionLabel>
                <View style={{ gap: 10 }}>
                  {pinRows.map((row) => (
                    <View
                      key={row.map((pin) => pin.id).join()}
                      style={{ flexDirection: 'row', gap: 10 }}
                    >
                      {row.map((pin) => (
                        <PinTile
                          key={pin.id}
                          width={tileWidth}
                          label={pin.label}
                          detail={
                            appById.get(pin.appId)?.description ||
                            appById.get(pin.appId)?.name ||
                            'App'
                          }
                          hash={pin.entryHash || undefined}
                          onPress={() =>
                            router.push({
                              pathname: '/apps/[id]',
                              params: {
                                id: pin.appId,
                                slug: pin.appSlug,
                                entryHash: pin.entryHash,
                                label: pin.label,
                              },
                            })
                          }
                        />
                      ))}
                    </View>
                  ))}
                </View>
              </>
            ) : null}
            {pinnedWorkflows.length ? (
              <>
                <SectionLabel count={pinnedWorkflows.length}>
                  Pinned workflows
                </SectionLabel>
                <Group>
                  {pinnedWorkflows.map((item) => (
                    <ListRow
                      key={item.id}
                      title={item.name}
                      detail={item.description || 'Automation'}
                      leading={<GlyphTile glyph="workflows" tone="lime" />}
                      onPress={() => open(item, 'workflows')}
                    />
                  ))}
                </Group>
              </>
            ) : null}
          </>
        ) : rows.length ? (
          <>
            <SectionLabel count={rows.length}>
              {search
                ? 'Matches'
                : `Every ${kind === 'apps' ? 'app' : 'workflow'}`}
            </SectionLabel>
            <Group>
              {rows.map((item, index) => (
                <IndexRow
                  key={item.id}
                  index={index + 1}
                  title={item.name}
                  detail={item.description || undefined}
                  onPress={() => open(item, kind)}
                  tags={
                    <>
                      <StatusTag status={item.status} />
                      {kind === 'apps' && pinsByApp.get(item.id) ? (
                        <Tag
                          tone="outline"
                          glyph="pin"
                          label={
                            pinsByApp.get(item.id) === 1
                              ? 'Pinned'
                              : `${pinsByApp.get(item.id)} pins`
                          }
                        />
                      ) : null}
                      {kind === 'workflows' &&
                      pinnedWorkflowIds.includes(item.id) ? (
                        <Tag tone="outline" glyph="pin" label="Pinned" />
                      ) : null}
                    </>
                  }
                />
              ))}
            </Group>
          </>
        ) : null}
      </View>
    </ScrollScreen>
  );
}
