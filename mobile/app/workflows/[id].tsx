import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSession } from '../../src/state/session';
import {
  Busy,
  Notice,
  Text,
  errorText,
  styles,
  usePalette,
} from '../../src/ui/primitives';
import { SectionLabel } from '../../src/ui/screen';
export default function WorkflowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin } = useSession();
  const c = usePalette();
  const query = useQuery({
    queryKey: [origin, 'workflow', id],
    queryFn: ({ signal }) => api!.workflow(id, signal),
    enabled: Boolean(api),
  });
  const data = query.data;
  return (
    <>
      <Stack.Screen options={{ title: 'Workflow' }} />
      {query.error ? (
        <Notice
          title="Couldn’t load this workflow"
          detail={errorText(query.error)}
          action={{ label: 'Try again', onPress: () => void query.refetch() }}
        />
      ) : !data ? (
        <Busy />
      ) : (
        <ScrollView
          style={styles.screen}
          contentContainerStyle={{ padding: 24 }}
        >
          <Text style={{ color: c.text, fontSize: 28, fontWeight: '700' }}>
            {data.name}
          </Text>
          <Text style={[styles.body, { color: c.muted, marginTop: 12 }]}>
            {data.description || 'An automation in your Hatch workspace.'}
          </Text>
          <SectionLabel>Status</SectionLabel>
          <Text style={[styles.body, { color: c.text }]}>
            {data.status === 'deployed' ? 'Deployed' : data.status}
          </Text>
          <SectionLabel>Last updated</SectionLabel>
          <Text style={[styles.body, { color: c.text }]}>
            {new Date(data.updatedAt).toLocaleString()}
          </Text>
          <View style={{ marginTop: 32 }}>
            <Notice
              title="Runs on your instance"
              detail="Manage triggers, run history and workflow settings in Hatch on the web."
            />
          </View>
        </ScrollView>
      )}
    </>
  );
}
