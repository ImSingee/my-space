import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import {
  HANDOFF_CONSUME_PATH,
  destinationUrl,
  webViewHandoffSource,
  type BrowserDestination,
  type SessionHandoff,
} from '../core';
import { Busy, Notice } from './primitives';
import { palette } from './theme';

// The published type omits the imperative ref the native view does forward.
type WebViewHandle = {
  goBack: () => void;
  injectJavaScript: (script: string) => void;
};
const SurfaceWebView = WebView as unknown as ComponentType<
  WebViewProps & { ref?: Ref<WebViewHandle> }
>;

function sameInstance(origin: string, value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** Navigates without adding an entry to the WebView's history. */
function replacePage(view: WebViewHandle | null, url: string) {
  view?.injectJavaScript(`location.replace(${JSON.stringify(url)}); true;`);
}

/**
 * One WebView, one non-persistent cookie store. The ticket is only form-POSTed;
 * after the server's exact completion page loads, the same WebView replaces it
 * with the requested page. Changing `destination` later replaces the page again
 * in that browser session. Replacing keeps the sign-in pages out of the
 * WebView's history, so nothing inside the view can step back onto them.
 */
export function SecureSurface({
  origin,
  handoff,
  destination,
  retry,
  onOpenApp,
  dashboardRefresh,
  onReady,
}: {
  origin: string;
  handoff: SessionHandoff;
  destination: BrowserDestination;
  retry: () => void;
  onOpenApp?: (slug: string) => void;
  dashboardRefresh?: { id: string; revision: number };
  onReady?: (ready: boolean) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const failed = useRef(false);
  const view = useRef<WebViewHandle>(null);
  const href = destinationUrl(origin, destination);
  useEffect(() => {
    if (signedIn) replacePage(view.current, href);
  }, [signedIn, href]);
  const ready = loadedPath === destination.path && !problem;
  useEffect(() => {
    onReady?.(ready);
    return () => onReady?.(false);
  }, [ready, onReady]);
  // A freshly loaded canvas is already current: only revisions requested after
  // it loaded become refresh commands.
  const sentRevision = useRef(dashboardRefresh?.revision);
  const refreshDashboardId = dashboardRefresh?.id;
  const refreshRevision = dashboardRefresh?.revision;
  useEffect(() => {
    if (!ready || !refreshDashboardId) return;
    if (refreshRevision === sentRevision.current) return;
    sentRevision.current = refreshRevision;
    const detail = JSON.stringify({ dashboardId: refreshDashboardId });
    view.current?.injectJavaScript(
      `window.dispatchEvent(new CustomEvent('hatch:dashboard-refresh', { detail: ${detail} })); true;`,
    );
  }, [ready, refreshDashboardId, refreshRevision]);
  const fail = (message: string) => {
    failed.current = true;
    setProblem(message);
  };
  if (problem)
    return (
      <View style={{ padding: 12 }}>
        <Notice
          tone="danger"
          title="Couldn’t open this view"
          detail={problem}
          action={{ label: 'Try again', onPress: retry }}
        />
      </View>
    );
  const target = destination.path;
  const inTarget = (url: URL) =>
    url.pathname === target ||
    (target.endsWith('/') && url.pathname.startsWith(target));
  // The source never changes: switching it would push a history entry.
  const source = webViewHandoffSource(origin, handoff);
  return (
    <View style={{ flex: 1, backgroundColor: palette.card }}>
      <SurfaceWebView
        ref={view}
        source={source}
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
        // Back belongs to the native stack, never to handoff/iframe history.
        allowsBackForwardNavigationGestures={false}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === 'about:blank') return true;
          // Dashboard widgets mount in sandboxed srcdoc subframes. Never allow
          // an opaque document to replace the authenticated top-level surface.
          if (request.url === 'about:srcdoc' && request.isTopFrame === false)
            return true;
          const url = sameInstance(origin, request.url);
          if (request.isTopFrame === false) return Boolean(url);
          if (url && !signedIn)
            return (
              url.pathname === HANDOFF_CONSUME_PATH ||
              url.href === handoff.completionUrl
            );
          if (url && inTarget(url)) return true;
          const app = url?.pathname.match(/^\/app\/([A-Za-z0-9_-]+)(?:\/|$)/);
          if (app && onOpenApp) {
            onOpenApp(app[1]);
            return false;
          }
          if (url?.pathname === '/login') {
            fail('Your session expired. Try again to reconnect securely.');
            return false;
          }
          let external: URL;
          try {
            external = new URL(request.url);
          } catch {
            return false;
          }
          if (
            !url &&
            external.protocol === 'https:' &&
            !external.username &&
            !external.password
          )
            Alert.alert('Open in your browser?', external.origin, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open',
                onPress: () =>
                  void WebBrowser.openBrowserAsync(external.href).catch(() =>
                    fail('Couldn’t open the browser.'),
                  ),
              },
            ]);
          return false;
        }}
        onNavigationStateChange={(state) => {
          // Single-page routing changes the URL without a load request, so it
          // bypasses onShouldStartLoadWithRequest. Keep the surface on its page;
          // App links open natively instead of inside this view.
          if (!signedIn || state.loading) return;
          const url = sameInstance(origin, state.url);
          if (!url || inTarget(url) || url.href === handoff.completionUrl)
            return;
          const app = url.pathname.match(/^\/app\/([A-Za-z0-9_-]+)(?:\/|$)/);
          if (state.canGoBack) view.current?.goBack();
          else replacePage(view.current, href);
          if (app && onOpenApp) onOpenApp(app[1]);
        }}
        onLoad={({ nativeEvent }) => {
          if (failed.current) return;
          // Only the exact completion page proves the cookie was stored.
          if (!signedIn) {
            if (nativeEvent.url === handoff.completionUrl) setSignedIn(true);
            return;
          }
          const url = sameInstance(origin, nativeEvent.url);
          if (url && inTarget(url)) {
            sentRevision.current = dashboardRefresh?.revision;
            setLoadedPath(target);
          }
        }}
        onError={() => fail('Check your connection and try again.')}
        onHttpError={({ nativeEvent }) => {
          if (nativeEvent.statusCode < 400) return;
          const url = sameInstance(origin, nativeEvent.url);
          fail(
            !signedIn
              ? 'This phone couldn’t sign the view in. Try again for a fresh, one-time sign-in.'
              : nativeEvent.statusCode === 404 && url && inTarget(url)
                ? 'This page is no longer available.'
                : `The server returned ${nativeEvent.statusCode}. Try again.`,
          );
        }}
        onContentProcessDidTerminate={retry}
        style={{ flex: 1, backgroundColor: palette.card }}
      />
      {loadedPath !== target ? (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: palette.card }]}
        >
          <Busy label={signedIn ? 'Opening' : 'Signing in securely'} />
        </View>
      ) : null}
    </View>
  );
}
