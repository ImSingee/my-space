import { Stack, useLocalSearchParams } from 'expo-router';
import { ResourcesScreen } from '../src/screens/resources';
import { AgentScreen } from '../src/screens/agent';
import { DashboardScreen } from '../src/screens/dashboard';
export default function Library() {
  const { kind, all } = useLocalSearchParams<{ kind?: string; all?: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Workspace', headerBackTitle: 'More' }} />
      {kind === 'dashboard' ? (
        <DashboardScreen nested />
      ) : kind === 'agent' ? (
        <AgentScreen nested />
      ) : (
        <ResourcesScreen
          nested
          kind={kind === 'workflows' ? 'workflows' : 'apps'}
          all={all === 'true'}
        />
      )}
    </>
  );
}
