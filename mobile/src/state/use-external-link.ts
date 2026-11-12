import { useCallback, useRef } from 'react';
import { Alert, Linking } from 'react-native';
import { externalUrl, type SessionHandoff } from '../core';

// A tap that both follows a link and opens a window still leaves only once.
const REPEAT_WINDOW_MS = 1500;

/**
 * The only way out of a web surface: the system opens a web page in its
 * default browser and any other scheme in the app that owns it. Every URL is
 * checked again with the shared policy here, whoever asks, so handoff pages
 * and tickets never leave, however they are encoded. Only the URL leaves: no
 * cookies or tokens. The link is opened without first asking whether an app
 * can take it, since that question needs each scheme declared ahead of time;
 * a failure keeps the page and says why.
 */
export function useExternalLink(origin: string, handoff: SessionHandoff) {
  const last = useRef<{ url: string; at: number } | null>(null);
  return useCallback(
    function open(value: string) {
      const url = externalUrl(value, { origin, handoff });
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
      void Linking.openURL(url).catch(() => {
        const { protocol, host } = new URL(url);
        if (protocol !== 'https:' && protocol !== 'http:') {
          // No installed app claims the scheme, so a retry cannot succeed.
          last.current = null;
          Alert.alert(
            'Couldn’t open the link',
            `No app on this device opens “${protocol.slice(0, -1)}” links.`,
          );
          return;
        }
        Alert.alert('Couldn’t open the link', host, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Try again',
            onPress: () => {
              last.current = null;
              open(url);
            },
          },
        ]);
      });
    },
    [origin, handoff],
  );
}
