/** Composition root for notification delivery adapters. */
import { ensureNotificationDispatcher } from '../dispatcher';
import { deliverToApp } from './app';
import { createDeviceAdapter } from './device';
import { deliverToWebhook } from './webhook';

export function startNotificationDelivery(): void {
  ensureNotificationDispatcher({
    device: createDeviceAdapter(),
    webhook: deliverToWebhook,
    app: deliverToApp,
  });
}
