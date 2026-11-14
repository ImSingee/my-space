import { useInfiniteQuery } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { Button } from '../../src/ui/button';
import { Reflow } from '../../src/ui/columns';
import { Busy, EmptyState, Notice, errorText } from '../../src/ui/primitives';
import {
  NotificationStatusTag,
  notificationTime,
} from '../../src/ui/notification-status';
import { Group } from '../../src/ui/rows';
import { ScrollScreen } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';
import { palette as c } from '../../src/ui/theme';

export default function NotificationsScreen() {
  const { api, origin } = useSession();
  const query = useInfiniteQuery({
    queryKey: [origin, 'notifications'],
    queryFn: ({ pageParam, signal }) =>
      api!.notifications(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
  });
  const pull = usePullToRefresh(useIsFocused(), () => query.refetch());
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const host = origin?.replace(/^https?:\/\//, '') ?? '';
  return (
    <ScrollScreen
      nested
      eyebrow={host}
      title="Notifications"
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={c.moss}
        />
      }
    >
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        {query.error ? (
          <Notice
            tone="danger"
            title="Couldn’t load notifications"
            detail={errorText(query.error)}
            action={{ label: 'Try again', onPress: () => void query.refetch() }}
          />
        ) : null}
        {!query.data && !query.error ? (
          <Busy label="Loading notifications" />
        ) : null}
        {query.data && items.length === 0 ? (
          <EmptyState
            title="No notifications yet"
            detail="Apps and channels on this instance send notifications here. Routing is set up in Hatch on the web."
          />
        ) : null}
        {items.length > 0 ? (
          <Reflow
            items={items}
            render={(column) => (
              <Group>
                {column.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.title}, from ${item.sourceName}`}
                    onPress={() => router.push(`/notifications/${item.id}`)}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && { backgroundColor: c.limeSoft },
                    ]}
                  >
                    <View style={styles.header}>
                      <Text style={[type.meta, styles.grow]} numberOfLines={1}>
                        {item.sourceName} · {item.kindName}
                      </Text>
                      <Text style={type.meta}>
                        {notificationTime(item.occurredAt)}
                      </Text>
                    </View>
                    <Text style={type.heading}>{item.title}</Text>
                    {item.body ? (
                      <Text style={type.small} numberOfLines={3}>
                        {item.body}
                      </Text>
                    ) : null}
                    <NotificationStatusTag status={item.status} />
                  </Pressable>
                ))}
              </Group>
            )}
          />
        ) : null}
        {query.hasNextPage ? (
          <Button
            variant="secondary"
            fullWidth
            label={query.isFetchingNextPage ? 'Loading…' : 'Load older'}
            busy={query.isFetchingNextPage}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null}
      </View>
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  header: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flex: 1 },
});
