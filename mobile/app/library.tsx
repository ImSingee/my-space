import { useLocalSearchParams } from 'expo-router';
import { ResourcesScreen } from '../src/screens/resources';
import { AgentScreen } from '../src/screens/agent';
import { DashboardScreen } from '../src/screens/dashboard';

// Hidden tabs stay reachable from More through this pushed screen.
export default function Library() {
  const { kind, all } = useLocalSearchParams<{ kind?: string; all?: string }>();
  return kind === 'dashboard' ? (
    <DashboardScreen nested />
  ) : kind === 'agent' ? (
    <AgentScreen nested />
  ) : (
    <ResourcesScreen
      nested
      kind={kind === 'workflows' ? 'workflows' : 'apps'}
      all={all === 'true'}
    />
  );
}
