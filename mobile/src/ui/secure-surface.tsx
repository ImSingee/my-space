import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentType,
  type Ref,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';
import {
  decideLoad,
  decideNewWindow,
  destinationUrl,
  surfaceRoute,
  webViewHandoffSource,
  type BrowserDestination,
  type DeepLink,
  type SessionHandoff,
  type SurfaceDecision,
} from '../core';
import { useExternalLink } from '../state/use-external-link';
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

export type SurfaceHandle = {
  goBack: () => void;
  /**
   * Moves the page to another route of its own (the part after `#`) as a
   * new history entry, so back returns to the page it left.
   */
  showRoute: (hash: string) => void;
};

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
  onRoute,
  dashboardRefresh,
  onReady,
  onHistoryBack,
  ref,
}: {
  origin: string;
  handoff: SessionHandoff;
  destination: BrowserDestination;
  retry: () => void;
  /** Opens a Hatch page that a link in this page leads to. */
  onRoute?: (link: DeepLink) => void;
  dashboardRefresh?: { id: string; revision: number };
  onReady?: (ready: boolean) => void;
  /**
   * Opts in to in-page back: reports whether the page has history of its own
   * to step back through, and turns on WKWebView's back swipe while it does.
   */
  onHistoryBack?: (canGoBack: boolean) => void;
  ref?: Ref<SurfaceHandle>;
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
  // WebKit's own canGoBack. The sign-in pages never enter history (they are
  // replaced) and refused or external loads never add to it, so it counts only
  // pages, pushState and hash steps the person actually visited.
  const [webCanGoBack, setWebCanGoBack] = useState(false);
  const historyBack =
    Boolean(onHistoryBack) && signedIn && ready && webCanGoBack;
  useEffect(() => {
    onHistoryBack?.(historyBack);
    return () => onHistoryBack?.(false);
  }, [historyBack, onHistoryBack]);
  useImperativeHandle(
    ref,
    () => ({
      goBack: () => view.current?.goBack(),
      showRoute: (hash) =>
        view.current?.injectJavaScript(
          `location.hash = ${JSON.stringify(`#${hash}`)}; true;`,
        ),
    }),
    [],
  );
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
  const openOutside = useExternalLink(origin, handoff);
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
  const context = {
    origin,
    target,
    handoff,
    signedIn,
    ready,
    canRoute: Boolean(onRoute),
    allowDevelopmentLoopback: __DEV__,
  };
  const follow = (decision: SurfaceDecision) => {
    switch (decision.action) {
      case 'external':
        openOutside(decision.url);
        break;
      case 'route':
        onRoute?.(decision.link);
        break;
      case 'expired':
        fail('Your session expired. Try again to reconnect securely.');
        break;
    }
    return decision.action === 'load';
  };
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
        // New windows reach onOpenWindow; scripts open one only on a tap.
        setSupportMultipleWindows
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        originWhitelist={['*']}
        // The edge swipe steps back through the page's own history, then
        // belongs to the native stack again.
        allowsBackForwardNavigationGestures={historyBack}
        onShouldStartLoadWithRequest={(request) =>
          follow(decideLoad(request, context))
        }
        onOpenWindow={({ nativeEvent }) => {
          follow(decideNewWindow(nativeEvent.targetUrl, context));
        }}
        onNavigationStateChange={(state) => {
          // Single-page routing changes the URL without a load request, so it
          // bypasses onShouldStartLoadWithRequest. Keep the surface on its page;
          // links to Hatch pages open natively instead of inside this view.
          if (!signedIn) return;
          setWebCanGoBack(state.canGoBack);
          if (state.loading) return;
          const url = sameInstance(origin, state.url);
          if (!url || inTarget(url) || url.href === handoff.completionUrl)
            return;
          // A page that routes itself to sign-in has lost its session; offer
          // the reconnect instead of stepping back onto the expired page.
          if (url.pathname === '/login') {
            fail('Your session expired. Try again to reconnect securely.');
            return;
          }
          if (state.canGoBack) view.current?.goBack();
          else replacePage(view.current, href);
          // Script routing counts only once the page is showing.
          const decision = ready ? surfaceRoute(url.href, context) : null;
          if (decision?.action === 'route') onRoute?.(decision.link);
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
