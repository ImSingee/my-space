import { describe, expect, it, vi } from 'vitest';
import {
  publishPlatformEvent,
  subscribePlatformEvents,
  type PlatformEvent,
} from './platform-events';

const event: PlatformEvent = {
  type: 'app.deployment.activated',
  appId: 'app-1',
  deploymentRevision: 'revision-2',
};

describe('Platform event hub', () => {
  it('broadcasts an event to every current subscriber', () => {
    const first = vi.fn<(event: PlatformEvent) => void>();
    const second = vi.fn<(event: PlatformEvent) => void>();
    const unsubscribeFirst = subscribePlatformEvents(first);
    const unsubscribeSecond = subscribePlatformEvents(second);

    publishPlatformEvent(event);

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(event);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('stops delivering events after unsubscription', () => {
    const subscriber = vi.fn<(event: PlatformEvent) => void>();
    const unsubscribe = subscribePlatformEvents(subscriber);
    unsubscribe();

    publishPlatformEvent(event);

    expect(subscriber).not.toHaveBeenCalled();
  });

  it('isolates subscriber failures from publishers and other subscribers', () => {
    const error = new Error('closed stream');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsubscribeFaulty = subscribePlatformEvents(() => {
      throw error;
    });
    const healthy = vi.fn<(event: PlatformEvent) => void>();
    const unsubscribeHealthy = subscribePlatformEvents(healthy);

    expect(() => publishPlatformEvent(event)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(event);
    expect(log).toHaveBeenCalledWith(
      'Platform event subscriber failed.',
      error,
    );

    unsubscribeFaulty();
    unsubscribeHealthy();
    log.mockRestore();
  });
});
