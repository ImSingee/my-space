import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { deliveryPlan, type DeepLink, type LinkTarget } from '../core';
import type { NavigationPreferences } from '../core/navigation-preferences';
import { errorText } from '../ui/primitives';
import { linkInbox, type LinkEntry } from './link-inbox';
import { useNavigationPreferences } from './navigation';
import { openSection } from './open-section';
import { useSession, vault } from './session';

/**
 * Opens a link followed in a page on screen, over that page. A link naming
 * another instance asks before switching.
 */
export function openSurfaceLink(link: DeepLink) {
  linkInbox.put({ link, trusted: false, from: 'surface' });
}

const host = (origin: string) => origin.replace(/^https?:\/\//, '');

/** Makes each delivery of the same page a new request to the screen. */
const nonce = () => String(Date.now());

/** Shows a page on the instance in use. Navigation only; nothing is changed. */
function openTarget(
  target: LinkTarget,
  origin: string,
  preferences: NavigationPreferences,
) {
  switch (target.kind) {
    case 'start':
      openSection(preferences.defaultTab, preferences);
      return;
    case 'tab':
      openSection(target.tab, preferences);
      return;
    case 'dashboard':
      openSection('dashboard', preferences, {
        dashboard: target.id,
        at: nonce(),
      });
      return;
    case 'conversation':
      // The list decides whether the conversation fits beside it.
      openSection('agent', preferences, { open: target.id, at: nonce() });
      return;
    case 'app':
      router.push({
        pathname: '/apps/[id]',
        params: {
          id: target.slug,
          slug: target.slug,
          ...(target.hash ? { entryHash: target.hash } : {}),
        },
      });
      return;
    case 'workflow':
      router.push({
        pathname: '/workflows/[id]',
        params: { id: target.slug, slug: target.slug },
      });
      return;
    case 'notifications':
      router.push('/notifications');
      return;
    case 'notification':
      router.push({
        pathname: '/notifications/[id]',
        params: { id: target.id },
      });
      return;
    case 'phone':
      router.push(
        target.page === 'tabs'
          ? '/navigation'
          : target.page === 'instance'
            ? '/settings'
            : '/notifications/settings',
      );
      return;
    case 'web': {
      const url = new URL(target.path, origin);
      if (url.origin !== origin || url.pathname !== target.path) return;
      if (target.hash) url.hash = target.hash;
      void WebBrowser.openBrowserAsync(url.href).catch((error: unknown) =>
        Alert.alert('Couldn’t open this page', errorText(error)),
      );
    }
  }
}

function confirmSwitch(origin: string | null, instance: string) {
  return new Promise<boolean>((resolve) =>
    Alert.alert(
      `Open on ${host(instance)}?`,
      origin
        ? `This link is for ${host(instance)}. You are using ${host(origin)}; Hatch switches to ${host(instance)} to open it.`
        : `Hatch switches to ${host(instance)} to open it.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Switch', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

/**
 * Opens links from the inbox: system links, notification taps and links
 * followed in web pages. Each waits until the saved sign-in is restored and
 * the stack for the instance it names is mounted. Mounted once at the root.
 */
export function useDeepLinkLifecycle() {
  const { ready, origin, epoch, connect } = useSession();
  const navigation = useNavigationPreferences();
  const [arrivals, setArrivals] = useState(0);
  useEffect(
    () => linkInbox.subscribe(() => setArrivals((value) => value + 1)),
    [],
  );
  const busy = useRef(false);
  const preferences = navigation.preferences;
  useEffect(() => {
    const entry = linkInbox.peek();
    if (!ready || !navigation.ready || !entry || busy.current) return;
    busy.current = true;
    // Resolves true when the inbox should be read again afterwards.
    const deliver = async (entry: LinkEntry): Promise<boolean> => {
      const { instance } = entry.link;
      const plan = deliveryPlan(entry.link, entry.trusted, {
        origin,
        instanceSignedIn:
          Boolean(instance) && instance !== origin
            ? Boolean(await vault.get(instance!).catch(() => null))
            : false,
      });
      // A newer link replaced this one while the vault was read.
      if (linkInbox.peek() !== entry) return true;
      switch (plan.step) {
        case 'hold':
          // Read again once an instance is signed in.
          return false;
        case 'open': {
          linkInbox.done(entry);
          const { target } = entry.link;
          const current = origin!;
          // Let a re-keyed stack mount before navigating on it.
          setTimeout(() => {
            if (entry.from === 'system' && router.canDismiss())
              router.dismissAll();
            openTarget(target, current, preferences);
          }, 0);
          return false;
        }
        case 'unavailable':
          linkInbox.done(entry);
          Alert.alert(
            `Not signed in to ${host(plan.instance)}`,
            `Sign in to ${host(plan.instance)} on this phone to open this.`,
          );
          return false;
        case 'switch': {
          if (plan.confirm && !(await confirmSwitch(origin, plan.instance))) {
            linkInbox.done(entry);
            return true;
          }
          if (linkInbox.peek() !== entry) return true;
          // Opens once the stack for that instance is mounted.
          await connect(plan.instance).catch((error: unknown) => {
            linkInbox.done(entry);
            Alert.alert(
              `Couldn’t switch to ${host(plan.instance)}`,
              errorText(error),
            );
          });
          // The new instance's stack opens it.
          return true;
        }
      }
    };
    void deliver(entry)
      .catch(() => true)
      .then((again) => {
        busy.current = false;
        // The session may have moved on, or a link arrived while busy.
        const next = linkInbox.peek();
        if (next && (again || next !== entry))
          setArrivals((value) => value + 1);
      });
  }, [ready, navigation.ready, origin, epoch, arrivals, connect, preferences]);
}
