import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { canonicalizeInstanceUrl } from '../core';
import { linkInbox } from './link-inbox';
import { pushRegistrar, pushSupported } from './push-registrar';
import { allowDevelopmentLoopback, useSession } from './session';

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

/**
 * Keeps the active instance's push registration fresh and hands notification
 * taps to the link inbox, which opens them on the instance that sent them.
 * Mounted once inside the session.
 */
export function usePushLifecycle() {
  const { ready, origin, api } = useSession();

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
    // Wait for the saved instance to be restored before taking a cold-start tap.
    if (!pushSupported || !ready) return;
    const open = (response: Notifications.NotificationResponse) => {
      const target = pushTarget(response);
      if (!target) return;
      // Only the extension writes this payload after decrypting it with the
      // instance's key, so it may switch to that instance without asking.
      linkInbox.put({
        link: {
          instance: target.origin,
          target: { kind: 'notification', id: target.notificationId },
        },
        trusted: true,
        from: 'system',
      });
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      Notifications.clearLastNotificationResponse();
      open(last);
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        Notifications.clearLastNotificationResponse();
        open(response);
      },
    );
    return () => subscription.remove();
  }, [ready]);
}
