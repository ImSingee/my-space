import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { canonicalizeInstanceUrl } from '../core';
import { pushRegistrar, pushSupported } from './push-registrar';
import { allowDevelopmentLoopback, useSession, vault } from './session';

// Show Hatch notifications as banners while the app is open too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

type PushTarget = { origin: string; notificationId: string };

/** Tap payload written by the Notification Service Extension after decrypting. */
export function pushTarget(
  response: Notifications.NotificationResponse | null,
): PushTarget | null {
  const data = response?.notification.request.content.data as
    | Record<string, unknown>
    | null
    | undefined;
  const origin = data?.hatchOrigin;
  const notificationId = data?.hatchNotificationId;
  if (typeof origin !== 'string' || typeof notificationId !== 'string')
    return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(notificationId)) return null;
  try {
    return {
      origin: canonicalizeInstanceUrl(origin, { allowDevelopmentLoopback }),
      notificationId,
    };
  } catch {
    return null;
  }
}

let pending: PushTarget | null = null;

/** Open a notification on the root stack, above any sheet left open. */
function openNotification(id: string) {
  if (router.canDismiss()) router.dismissAll();
  router.push(`/notifications/${id}`);
}

/**
 * Keeps the active instance's push registration fresh and routes notification
 * taps to the instance that sent them. Mounted once inside the session.
 */
export function usePushLifecycle() {
  const { ready, origin, api, epoch, connect } = useSession();
  const current = useRef({ origin, connect });
  useEffect(() => {
    current.current = { origin, connect };
  });

  useEffect(() => {
    if (!pushSupported || !origin || !api) return;
    void pushRegistrar.refresh(origin, api).catch(() => {});
    // Register the token this listener received. Requesting a token again
    // here would fire the listener again (Expo warns of an infinite loop).
    const subscription = Notifications.addPushTokenListener((token) => {
      void pushRegistrar
        .refresh(origin, api, String(token.data))
        .catch(() => {});
    });
    return () => subscription.remove();
  }, [origin, api]);

  useEffect(() => {
    if (pending && origin && pending.origin === origin) {
      const id = pending.notificationId;
      pending = null;
      // Let the re-keyed stack mount before pushing onto it.
      setTimeout(() => openNotification(id), 0);
    }
  }, [origin, epoch]);

  useEffect(() => {
    // Wait for the saved instance to be restored before routing a cold-start tap.
    if (!pushSupported || !ready) return;
    const open = async (response: Notifications.NotificationResponse) => {
      const target = pushTarget(response);
      if (!target) return;
      if (target.origin === current.current.origin) {
        openNotification(target.notificationId);
        return;
      }
      if (!(await vault.get(target.origin))) {
        Alert.alert(
          'Sign in to open this notification',
          `It came from ${target.origin.replace(/^https?:\/\//, '')}, which this phone is not signed in to.`,
        );
        return;
      }
      pending = target;
      await current.current.connect(target.origin).catch(() => {
        pending = null;
      });
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      Notifications.clearLastNotificationResponse();
      void open(last);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        Notifications.clearLastNotificationResponse();
        void open(response);
      },
    );
    return () => subscription.remove();
  }, [ready]);
}
