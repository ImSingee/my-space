import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Linking } from 'react-native';
import { resolveLink } from '../core/deep-link';
import { pushTap, verifiedTapUrl, type PushTap } from '../core/push';
import { linkInbox } from './link-inbox';
import {
  nativePushPlatform,
  pushRegistrar,
  pushSupported,
} from './push-registrar';
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

/**
 * Opens the notification itself on the instance that sent it. Only the
 * extension writes this payload after decrypting it with the instance's key,
 * so it may switch to that instance without asking.
 */
function openNotification(target: PushTap) {
  linkInbox.put({
    link: {
      instance: target.origin,
      target: { kind: 'notification', id: target.notificationId },
    },
    trusted: true,
    from: 'system',
  });
}

/**
 * Opens a verified tap URL. A Hatch page opens in the app, on the instance
 * that sent the push unless the link names another one (which then asks
 * before switching); anything else leaves for the system. Returns false when
 * nothing could open it.
 */
async function openTapUrl(target: PushTap, url: string) {
  const link = resolveLink(url, target.origin, { allowDevelopmentLoopback });
  if (link && link.target.kind !== 'web') {
    const instance = link.instance ?? target.origin;
    linkInbox.put({
      link: { instance, target: link.target },
      trusted: instance === target.origin,
      from: 'system',
    });
    return true;
  }
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
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
    const open = async (response: Notifications.NotificationResponse) => {
      const target = pushTap(response.notification.request.content.data, {
        allowDevelopmentLoopback,
      });
      if (!target) return;
      // The sender asked for the link instead of the notification. If it is
      // not verified or nothing can open it, the notification opens and
      // still shows its link.
      const url = await verifiedTapUrl(target, nativePushPlatform);
      if (url && (await openTapUrl(target, url))) return;
      openNotification(target);
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
