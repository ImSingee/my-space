/** Shared types for delivery adapters (device, webhook, App). */
import type { schema } from '~/db';
import type { NotificationRecord } from './contract';

export type DestinationRow =
  typeof schema.notificationDestinations.$inferSelect;

export type DeliveryContext = {
  deliveryId: string;
  /** 1-based attempt number of this delivery. */
  attempt: number;
  notification: NotificationRecord;
  destination: DestinationRow;
  /** Current slug of the source App, when the source is an App. */
  sourceSlug: string | null;
};

/** Optional side effects on the destination itself. */
type DestinationUpdate = {
  /** Disable the destination (e.g. APNs reports the token is gone). */
  disable?: boolean;
  /** Record or clear a configuration error shown in settings. */
  lastError?: string | null;
  /**
   * Apply only while the destination still has this APNs token, so a token
   * the phone replaced mid-delivery is never blamed for the old one.
   */
  ifApnsToken?: string;
};

export type DeliveryOutcome =
  | {
      kind: 'success';
      httpStatus?: number;
      /** Free-form result string returned by an App destination. */
      result?: string | null;
      destination?: DestinationUpdate;
    }
  | {
      kind: 'retry' | 'fail';
      error: string;
      httpStatus?: number;
      destination?: DestinationUpdate;
    };

export type DeliveryAdapter = (
  context: DeliveryContext,
) => Promise<DeliveryOutcome>;

/** Map an HTTP status to success / retryable / permanent failure. */
export function classifyHttpStatus(
  status: number,
): 'success' | 'retry' | 'fail' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'fail';
}
