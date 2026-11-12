import { createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  type CreateChannelRequest,
  type CreateRouteRequest,
  type UpdateGroupRequest,
  type UpdateRouteRequest,
} from '../../hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import {
  executeNotificationCall,
  parseNotificationCommand,
} from './notifications';

const argv = (...parts: string[]) => ['notification', ...parts];
const parse = (...parts: string[]) =>
  parseNotificationCommand(argv(...parts), 0).call;

function recordingTransport() {
  const received: {
    createRoute?: CreateRouteRequest;
    updateRoute?: UpdateRouteRequest;
    createChannel?: CreateChannelRequest;
    updateGroup?: UpdateGroupRequest;
  } = {};
  const transport = createRouterTransport(({ service }) => {
    service(NotificationService, {
      createRoute: (request) => {
        received.createRoute = request;
        return {
          route: {
            id: 'route-1',
            sourceType: request.sourceType,
            sourceId: request.sourceId,
            kind: request.kind,
            targetType: request.targetType,
            targetId: request.targetId,
            enabled: request.enabled ?? true,
            createdAt: 'now',
            updatedAt: 'now',
          },
        };
      },
      updateRoute: (request) => {
        received.updateRoute = request;
        return {};
      },
      createChannel: (request) => {
        received.createChannel = request;
        return {
          channel: {
            id: 'channel-1',
            name: request.name,
            kinds: request.kinds?.kinds ?? [],
            enabled: true,
            pushUrl:
              'https://hatch.example/api/notifications/channel/channel-1',
            createdAt: 'now',
            updatedAt: 'now',
          },
          token: 'hnc_secret-token',
        };
      },
      updateGroup: (request) => {
        received.updateGroup = request;
        return {};
      },
    });
  });
  return { transport, received };
}

describe('notification route commands', () => {
  it('maps create flags onto CreateRoute, including a disabled rule', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'route',
        'create',
        '--source-type',
        'app',
        '--source',
        'app-1',
        '--kind',
        'order.shipped',
        '--group',
        'group-1',
        '--disabled',
      ),
    );
    expect(received.createRoute).toMatchObject({
      sourceType: 'app',
      sourceId: 'app-1',
      kind: 'order.shipped',
      targetType: 'group',
      targetId: 'group-1',
      enabled: false,
    });
    expect(result.text).toContain('app:app-1 / order.shipped');
  });

  it('requires exactly one target and no source for any-source rules', () => {
    expect(() =>
      parse(
        'route',
        'create',
        '--source-type',
        'any',
        '--group',
        'g',
        '--destination',
        'd',
      ),
    ).toThrow(/only one of --group, --destination/);
    expect(() => parse('route', 'create', '--source-type', 'any')).toThrow(
      /--group or --destination/,
    );
    expect(() =>
      parse(
        'route',
        'create',
        '--source-type',
        'any',
        '--source',
        'app-1',
        '--group',
        'g',
      ),
    ).toThrow(/--source cannot be combined/);
  });

  it('sends empty strings to clear source and kind filters on update', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('route', 'update', 'route-1', '--any-source', '--any-kind'),
    );
    // Presence of an empty value means "match any"; absence means unchanged.
    expect(received.updateRoute?.sourceId).toBe('');
    expect(received.updateRoute?.kind).toBe('');
    expect(received.updateRoute?.targetId).toBeUndefined();
    expect(received.updateRoute?.enabled).toBeUndefined();
  });
});

describe('notification channel commands', () => {
  it('parses repeatable kinds and prints the one-time token and push URL', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'channel',
        'create',
        '--name',
        'Monitoring',
        '--kind',
        'host.down:Host down',
        '--kind',
        'backup.done',
      ),
    );
    expect(received.createChannel?.kinds?.kinds).toEqual([
      expect.objectContaining({ kind: 'host.down', name: 'Host down' }),
      expect.objectContaining({ kind: 'backup.done', name: 'backup.done' }),
    ]);
    expect(result.text).toContain('Token: hnc_secret-token');
    expect(result.text).toContain(
      'https://hatch.example/api/notifications/channel/channel-1',
    );
    expect(result.json).toMatchObject({ token: 'hnc_secret-token' });
  });

  it('rejects malformed kinds before calling the platform', () => {
    expect(() =>
      parse('channel', 'create', '--name', 'X', '--kind', 'Bad Kind'),
    ).toThrow(/Invalid kind/);
    expect(() => parse('channel', 'create', '--name', 'X')).toThrow(
      /at least one --kind/,
    );
  });
});

describe('notification group commands', () => {
  it('distinguishes clearing members from leaving them unchanged', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--clear-destinations'),
    );
    expect(received.updateGroup?.destinationIds?.ids).toEqual([]);

    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--name', 'Phones'),
    );
    expect(received.updateGroup?.destinationIds).toBeUndefined();
    expect(() =>
      parse(
        'group',
        'update',
        'group-1',
        '--destination',
        'd',
        '--clear-destinations',
      ),
    ).toThrow(/only one of/);
  });
});
