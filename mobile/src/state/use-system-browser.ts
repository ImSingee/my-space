import { useCallback, useRef } from 'react';
import { Alert, Linking } from 'react-native';
import { browserUrl, type SessionHandoff } from '../core';

// A tap that both follows a link and opens a window still leaves only once.
const REPEAT_WINDOW_MS = 1500;

/**
 * The only way out of a web surface to the system's default browser. Every
 * URL is checked again with the shared policy here, whoever asks, so handoff
 * pages and tickets never leave, however they are encoded. Only the URL
 * leaves: no cookies or tokens. A failure keeps the page and offers a retry.
 */
export function useSystemBrowser(origin: string, handoff: SessionHandoff) {
  const last = useRef<{ url: string; at: number } | null>(null);
  return useCallback(
    function open(value: string) {
      const url = browserUrl(value, { origin, handoff });
      if (!url) return;
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
    },
    [origin, handoff],
  );
}
