import { useState } from 'react';
import { Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import {
  APP_HANDOFF_PATH,
  webViewHandoffSource,
  type AppHandoff,
} from '../core';
import { Busy, Notice } from './primitives';

/** The token never enters web content; a one-use POST establishes HttpOnly auth. */
export function SecureSurface({
  origin,
  handoff,
  retry,
  entryHash,
  onOpenApp,
}: {
  origin: string;
  handoff: AppHandoff;
  retry: () => void;
  entryHash?: string;
  onOpenApp?: (slug: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  if (problem)
    return (
      <Notice
        title="Couldn’t open this view"
        detail={problem}
        action={{ label: 'Try again', onPress: retry }}
      />
    );
  const targetPath = new URL(handoff.targetPath, origin).pathname;
  return (
    <WebView
      source={webViewHandoffSource(origin, handoff)}
      incognito
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      originWhitelist={['*']}
      allowsBackForwardNavigationGestures
      injectedJavaScriptBeforeContentLoaded={
        entryHash
          ? `if (location.pathname === ${JSON.stringify(targetPath)}) location.hash = ${JSON.stringify(entryHash)}; true;`
          : undefined
      }
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === 'about:blank') return true;
        // Dashboard widgets mount in sandboxed srcdoc subframes. Never allow
        // an opaque document to replace the authenticated top-level surface.
        if (request.url === 'about:srcdoc' && request.isTopFrame === false)
          return true;
        let url: URL;
        try {
          url = new URL(request.url);
        } catch {
          return false;
        }
        const same = url.origin === origin && !url.username && !url.password;
        const inTarget =
          url.pathname === targetPath ||
          (targetPath.endsWith('/') && url.pathname.startsWith(targetPath));
        if (same && (url.pathname === APP_HANDOFF_PATH || inTarget))
          return true;
        if (request.isTopFrame === false) return same;
        const app = same && url.pathname.match(/^\/app\/([a-z0-9-]+)\/?$/);
        if (app && onOpenApp) {
          onOpenApp(app[1]);
          return false;
        }
        if (same && url.pathname === '/login') {
          setProblem('Your session expired. Reload to reconnect securely.');
          return false;
        }
        if (url.protocol === 'https:' && !url.username && !url.password)
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
        return false;
      }}
      onError={() => setProblem('Check your connection and try again.')}
      onHttpError={(event) => {
        if (event.nativeEvent.statusCode >= 400)
          setProblem(
            `The server returned ${event.nativeEvent.statusCode}. Reload to try again.`,
          );
      }}
      onContentProcessDidTerminate={retry}
      startInLoadingState
      renderLoading={() => <Busy label="Opening securely…" />}
      style={{ flex: 1, backgroundColor: '#ffffff' }}
    />
  );
}
