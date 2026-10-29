import { Redirect } from 'expo-router';
import { useNavigationPreferences } from '../src/state/navigation';
import { Busy } from '../src/ui/primitives';
export default function LaunchScreen() {
  const { ready, preferences } = useNavigationPreferences();
  if (!ready) return <Busy label="Opening Hatch…" />;
  return <Redirect href={`/(tabs)/${preferences.defaultTab}`} />;
}
