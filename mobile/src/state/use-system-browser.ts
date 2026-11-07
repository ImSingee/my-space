import { useCallback, useRef } from 'react';
import { Alert, Linking } from 'react-native';

// A tap that both follows a link and opens a window still leaves only once.
const REPEAT_WINDOW_MS = 1500;

/**
 * Opens an already vetted URL in the system's default browser, outside the
 * app. Only the URL leaves: no cookies or tokens. A failure keeps the current
 * page and offers a retry.
 */
export function useSystemBrowser() {
  const last = useRef<{ url: string; at: number } | null>(null);
  return useCallback(function open(url: string) {
    const now = Date.now();
    const previous = last.current;
    if (
      previous &&
      previous.url === url &&
      now - previous.at < REPEAT_WINDOW_MS
    )
      return;
    last.current = { url, at: now };
    void Linking.openURL(url).catch(() =>
      Alert.alert('Couldn’t open the link', new URL(url).host, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Try again',
          onPress: () => {
            last.current = null;
            open(url);
          },
        },
      ]),
    );
  }, []);
}
