import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  defaultNavigation,
  normalizeNavigation,
  type NavigationPreferences,
} from '../core/navigation-preferences';

const key = 'navigation-v1';
const options = {
  keychainService: 'app.hatch.mobile.preferences',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const NavigationContext = createContext<{
  ready: boolean;
  preferences: NavigationPreferences;
  saving: boolean;
  error: string | null;
  save: (value: NavigationPreferences) => Promise<void>;
} | null>(null);
export function NavigationProvider({ children }: PropsWithChildren) {
  const [ready, setReady] = useState(false);
  const [preferences, setPreferences] = useState(defaultNavigation);
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void SecureStore.getItemAsync(key, options)
      .then((raw) => {
        try {
          if (raw) setPreferences(normalizeNavigation(JSON.parse(raw)));
        } catch {
          setError(
            'Saved navigation could not be read. Default tabs are shown.',
          );
        }
      })
      .catch(() => setError('Couldn’t read this device’s navigation settings.'))
      .finally(() => setReady(true));
  }, []);
  const save = async (value: NavigationPreferences) => {
    if (saveInProgress.current) return;
    saveInProgress.current = true;
    setSaving(true);
    setError(null);
    const next = normalizeNavigation(value);
    try {
      await SecureStore.setItemAsync(key, JSON.stringify(next), options);
      setPreferences(next);
    } catch {
      setError('Couldn’t save on this device. Please try again.');
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  };
  return (
    <NavigationContext.Provider
      value={{ ready, preferences, saving, error, save }}
    >
      {children}
    </NavigationContext.Provider>
  );
}
export function useNavigationPreferences() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('NavigationProvider is missing');
  return value;
}
