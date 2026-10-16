import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { webViewHandoffSource } from '../../src/core';
import { useSession } from '../../src/state/session';
import {
  Busy,
  Notice,
  Action,
  errorText,
  styles,
  usePalette,
} from '../../src/ui/primitives';

export default function AppScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin, epoch } = useSession();
  const c = usePalette();
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const app = useQuery({
    queryKey: [origin, 'app', id],
    queryFn: ({ signal }) => api!.app(id, signal),
    enabled: Boolean(api),
  });
  const handoff = useQuery({
    queryKey: [origin, 'app-handoff', id, epoch, attempt],
    queryFn: ({ signal }) => api!.handoff(id, signal),
    enabled: Boolean(api && app.data),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = () => {
    setProblem(null);
    void app.refetch();
    setAttempt((value) => value + 1);
  };
  const data = handoff.data;
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: app.data?.name ?? 'App',
          headerRight: () => (
            <Action compact secondary label="Reload" onPress={retry} />
          ),
        }}
      />
      {problem || app.error || handoff.error ? (
        <Notice
          title="Couldn’t open this app"
          detail={problem ?? errorText(app.error ?? handoff.error)}
          action={{ label: 'Try again', onPress: retry }}
        />
      ) : !data ? (
        <Busy label="Opening your app securely…" />
      ) : (
        <WebView
          key={`${epoch}-${attempt}`}
          source={webViewHandoffSource(origin!, data)}
          incognito
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowsBackForwardNavigationGestures
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={(request) => {
            if (request.url === 'about:blank') return true;
            let url: URL;
            try {
              url = new URL(request.url);
            } catch {
              return false;
            }
            const sameOrigin =
              url.origin === origin && !url.username && !url.password;
            const allowedPath =
              url.pathname === '/api/mobile/v1/handoffs/consume' ||
              url.pathname.startsWith(data.targetPath);
            if (sameOrigin && allowedPath) return true;
            if (request.isTopFrame === false) return sameOrigin;
            if (sameOrigin && url.pathname === '/login') {
              setProblem(
                'The app session expired. Reload to create a new secure session.',
              );
              return false;
            }
            if (url.protocol === 'https:' && !url.username && !url.password) {
              Alert.alert('Open in your browser?', url.origin, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Open',
                  onPress: () =>
                    void WebBrowser.openBrowserAsync(url.href).catch(() =>
                      setProblem('Couldn’t open the browser.'),
                    ),
                },
              ]);
            }
            return false;
          }}
          onError={() =>
            setProblem(
              'The app could not load. Check your connection and try again.',
            )
          }
          onHttpError={(event) => {
            if (event.nativeEvent.statusCode >= 400)
              setProblem(
                `The server returned ${event.nativeEvent.statusCode}. Reload to try again.`,
              );
          }}
          onContentProcessDidTerminate={retry}
          startInLoadingState
          renderLoading={() => <Busy label="Loading app…" />}
          style={{ flex: 1, backgroundColor: c.background }}
        />
      )}
    </View>
  );
}
