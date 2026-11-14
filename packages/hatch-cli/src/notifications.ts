/** `hatch notification ...`: notification center history and configuration. */
import { parseArgs } from 'node:util';
import { toJson, type JsonValue } from '@bufbuild/protobuf';
import { createClient, type Transport } from '@connectrpc/connect';
import { NotificationService } from '../../hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import { configPath, resolveCredential } from './config';
import { platformTransport } from './client';
import { CliError } from './error';

type Method = keyof typeof NotificationService.method;
type Values = Record<string, string | boolean | string[] | undefined>;

/** One resolved RPC call plus its human-readable rendering. */
export type NotificationCall = {
  method: Method;
  request: Record<string, unknown>;
  text: (response: Record<string, unknown>) => string;
};

type Spec = {
  positionals: readonly string[];
  options?: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  build: (positionals: string[], values: Values) => NotificationCall;
};

const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function invalid(message: string): never {
  throw new CliError('invalid_arguments', message);
}

/** `kind[:Display name]`; the display name defaults to the kind. */
export function parseKindSpec(value: string) {
  const separator = value.indexOf(':');
  const kind = separator === -1 ? value : value.slice(0, separator);
  const name = (separator === -1 ? value : value.slice(separator + 1)).trim();
  if (!KIND_RE.test(kind))
    invalid(
      `Invalid kind "${kind}": use 1-64 lowercase letters, digits, ".", "_" or "-".`,
    );
  if (!name || name.length > 80)
    invalid(`Kind "${kind}" needs a display name of 1-80 characters.`);
  return { kind, name };
}

function exclusive(values: Values, ...flags: string[]) {
  const present = flags.filter((flag) => values[flag] !== undefined);
  if (present.length > 1)
    invalid(`Use only one of ${flags.map((flag) => `--${flag}`).join(', ')}.`);
}

function enabledFlag(values: Values): boolean | undefined {
  exclusive(values, 'enable', 'disable');
  return values.enable ? true : values.disable ? false : undefined;
}

function str(values: Values, flag: string): string | undefined {
  const value = values[flag];
  return typeof value === 'string' ? value : undefined;
}

function list(values: Values, flag: string): string[] | undefined {
  const value = values[flag];
  return Array.isArray(value) ? value : undefined;
}

function target(values: Values) {
  exclusive(values, 'group', 'destination');
  const group = str(values, 'group');
  const destination = str(values, 'destination');
  if (group) return { targetType: 'group', targetId: group };
  if (destination) return { targetType: 'destination', targetId: destination };
  return undefined;
}

function sourceType(value: string | undefined, allowed: readonly string[]) {
  if (value !== undefined && !allowed.includes(value))
    invalid(`--source-type must be one of ${allowed.join(', ')}.`);
  return value;
}

type Row = Record<string, unknown>;
const rows = (value: unknown) => (Array.isArray(value) ? (value as Row[]) : []);
const field = (row: Row | undefined, key: string) =>
  row?.[key] === undefined || row[key] === null ? '' : String(row[key]);
const table = (lines: string[][]) => {
  if (lines.length === 0) return '(none)';
  const widths = lines[0].map((_, index) =>
    Math.max(...lines.map((line) => line[index]?.length ?? 0)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, index) =>
          index === line.length - 1 ? cell : cell.padEnd(widths[index]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
};

function destinationLines(response: Record<string, unknown>, key: string) {
  return table(
    rows(response[key]).map((row) => {
      const detail =
        field(row.webhook as Row, 'url') ||
        field(row.app as Row, 'slug') ||
        [
          field(row.device as Row, 'userName'),
          field(row.device as Row, 'environment'),
        ]
          .filter(Boolean)
          .join(' · ');
      return [
        field(row, 'id'),
        field(row, 'type'),
        row.enabled === false ? 'disabled' : 'enabled',
        field(row, 'name'),
        detail,
      ];
    }),
  );
}

function routeLine(row: Row) {
  const source =
    field(row, 'sourceType') === 'any'
      ? 'any source'
      : `${field(row, 'sourceType')}:${field(row, 'sourceId') || '*'}`;
  return [
    field(row, 'id'),
    row.enabled === false ? 'disabled' : 'enabled',
    `${source} / ${field(row, 'kind') || '*'}`,
    `→ ${field(row, 'targetType')}:${field(row, 'targetId')}`,
    field(row, 'name'),
  ];
}

function channelSecret(response: Record<string, unknown>, label: string) {
  const channel = response.channel as Row | undefined;
  return [
    ...(channel
      ? [`Channel ${field(channel, 'id')} (${field(channel, 'name')})`]
      : []),
    ...(channel ? [`Push URL: ${field(channel, 'pushUrl')}`] : []),
    `${label}: ${field(response, 'token')}`,
    'Store it now; it is not shown again. Send it as x-hatch-secret.',
    ...(channel
      ? []
      : ['The push URL is unchanged; see hatch notification channel list.']),
  ].join('\n');
}

const done = (message: string) => () => message;
const id = { positionals: ['id'] } as const;

const specs: Record<string, Spec> = {
  list: {
    positionals: [],
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
    },
    build: (_positionals, values) => {
      const status = str(values, 'status');
      if (
        status !== undefined &&
        !['unrouted', 'pending', 'delivered', 'partial', 'failed'].includes(
          status,
        )
      )
        invalid(
          '--status must be unrouted, pending, delivered, partial or failed.',
        );
      const limit = str(values, 'limit');
      const parsedLimit = limit === undefined ? undefined : Number(limit);
      if (
        parsedLimit !== undefined &&
        (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
      )
        invalid('--limit must be an integer between 1 and 100.');
      return {
        method: 'listNotifications',
        request: {
          sourceType: sourceType(str(values, 'source-type'), [
            'app',
            'channel',
            'platform',
          ]),
          sourceId: str(values, 'source'),
          kind: str(values, 'kind'),
          status,
          cursor: str(values, 'cursor'),
          limit: parsedLimit ?? 0,
        },
        text: (response) => {
          const lines = table(
            rows(response.notifications).map((row) => [
              field(row, 'id'),
              field(row, 'createdAt'),
              field(row, 'status'),
              `${field(row, 'sourceName')} / ${field(row, 'kind')}`,
              field(row, 'title'),
            ]),
          );
          const next = field(response, 'nextCursor');
          return next ? `${lines}\nMore: --cursor ${next}` : lines;
        },
      };
    },
  },
  get: {
    ...id,
    build: ([notificationId]) => ({
      method: 'getNotification',
      request: { id: notificationId },
      text: (response) => {
        const detail = response.notification as Row | undefined;
        const summary = detail?.summary as Row | undefined;
        const deliveries = rows(detail?.deliveries).map((row) => {
          const extra = [
            field(row, 'result') && `result: ${field(row, 'result')}`,
            field(row, 'lastError') && `error: ${field(row, 'lastError')}`,
          ]
            .filter(Boolean)
            .join(' · ');
          return [
            field(row, 'id'),
            field(row, 'status'),
            `${field(row, 'destinationType')}:${field(row, 'destinationName')}`,
            `attempts ${field(row, 'attempts')}`,
            extra,
          ];
        });
        return [
          `${field(summary, 'title')} (${field(summary, 'status')})`,
          `Source: ${field(summary, 'sourceName')} (${field(summary, 'sourceType')}) · Kind: ${field(summary, 'kindName')} [${field(summary, 'kind')}]`,
          `Occurred: ${field(summary, 'occurredAt')}`,
          ...(field(summary, 'body') ? ['', field(summary, 'body')] : []),
          ...(field(summary, 'url')
            ? [
                `URL: ${field(summary, 'url')}${
                  summary?.autoOpenUrl === true ? ' (opens on phone tap)' : ''
                }`,
              ]
            : []),
          '',
          'Deliveries:',
          table(deliveries),
        ].join('\n');
      },
    }),
  },
  test: {
    positionals: ['destination-id'],
    build: ([destinationId]) => ({
      method: 'sendTestNotification',
      request: { destinationId },
      text: (response) =>
        `Sent test notification ${field(response, 'notificationId')}.`,
    }),
  },
  retry: {
    positionals: ['delivery-id'],
    build: ([deliveryId]) => ({
      method: 'retryDelivery',
      request: { deliveryId },
      text: done('Delivery queued for retry.'),
    }),
  },
  sources: {
    positionals: [],
    build: () => ({
      method: 'listNotificationSources',
      request: {},
      text: (response) => {
        const kindText = (row: Row) =>
          rows(row.kinds)
            .map((kind) => field(kind, 'kind'))
            .join(', ');
        return table([
          ...rows(response.apps).map((row) => [
            'app',
            field(row, 'id'),
            field(row, 'name'),
            kindText(row),
          ]),
          ...rows(response.channels).map((row) => [
            'channel',
            field(row, 'id'),
            field(row, 'name'),
            kindText(row),
          ]),
        ]);
      },
    }),
  },
  'destination list': {
    positionals: [],
    build: () => ({
      method: 'listDestinations',
      request: {},
      text: (response) => destinationLines(response, 'destinations'),
    }),
  },
  'destination enable': {
    ...id,
    build: ([destinationId]) => ({
      method: 'updateDestination',
      request: { id: destinationId, enabled: true },
      text: done('Destination enabled.'),
    }),
  },
  'destination disable': {
    ...id,
    build: ([destinationId]) => ({
      method: 'updateDestination',
      request: { id: destinationId, enabled: false },
      text: done('Destination disabled.'),
    }),
  },
  'destination rename': {
    positionals: ['id', 'name'],
    build: ([destinationId, name]) => ({
      method: 'updateDestination',
      request: { id: destinationId, name },
      text: done('Destination renamed.'),
    }),
  },
  'destination delete': {
    ...id,
    build: ([destinationId]) => ({
      method: 'deleteDestination',
      request: { id: destinationId },
      text: done('Destination deleted.'),
    }),
  },
  'webhook create': {
    positionals: [],
    options: { name: { type: 'string' }, url: { type: 'string' } },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      const url = str(values, 'url');
      if (!name || !url) invalid('Supply --name and --url.');
      return {
        method: 'createWebhook',
        request: { name, url },
        text: (response) =>
          [
            `Webhook ${field(response.destination as Row, 'id')} created.`,
            `Signing secret: ${field(response, 'secret')}`,
            'Store it now; it is not shown again. Verify x-hatch-signature with it.',
          ].join('\n'),
      };
    },
  },
  'webhook update': {
    ...id,
    options: { name: { type: 'string' }, url: { type: 'string' } },
    build: ([destinationId], values) => {
      const request = {
        id: destinationId,
        name: str(values, 'name'),
        url: str(values, 'url'),
      };
      if (request.name === undefined && request.url === undefined)
        invalid('Supply --name and/or --url.');
      return {
        method: 'updateDestination',
        request,
        text: done('Webhook updated.'),
      };
    },
  },
  'webhook rotate-secret': {
    ...id,
    build: ([destinationId]) => ({
      method: 'rotateWebhookSecret',
      request: { id: destinationId },
      text: (response) =>
        `New signing secret: ${field(response, 'secret')}\nStore it now; it is not shown again.`,
    }),
  },
  'webhook delete': {
    ...id,
    build: ([destinationId]) => ({
      method: 'deleteDestination',
      request: { id: destinationId },
      text: done('Webhook deleted.'),
    }),
  },
  'group list': {
    positionals: [],
    build: () => ({
      method: 'listGroups',
      request: {},
      text: (response) =>
        table(
          rows(response.groups).map((row) => [
            field(row, 'id'),
            field(row, 'name'),
            `${Array.isArray(row.destinationIds) ? row.destinationIds.length : 0} destination(s)`,
            row.autoAddDevices === true ? 'auto-adds new devices' : '',
          ]),
        ),
    }),
  },
  'group create': {
    positionals: [],
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      destination: { type: 'string', multiple: true },
      'auto-add-devices': { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      if (!name) invalid('Supply --name.');
      return {
        method: 'createGroup',
        request: {
          name,
          description: str(values, 'description'),
          autoAddDevices: values['auto-add-devices'] ? true : undefined,
          destinationIds: { ids: list(values, 'destination') ?? [] },
        },
        text: (response) =>
          `Group ${field(response.group as Row, 'id')} created.`,
      };
    },
  },
  'group update': {
    ...id,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      destination: { type: 'string', multiple: true },
      'clear-destinations': { type: 'boolean' },
      'auto-add-devices': { type: 'boolean' },
      'no-auto-add-devices': { type: 'boolean' },
    },
    build: ([groupId], values) => {
      exclusive(values, 'destination', 'clear-destinations');
      exclusive(values, 'auto-add-devices', 'no-auto-add-devices');
      const destinations = values['clear-destinations']
        ? []
        : list(values, 'destination');
      const request = {
        id: groupId,
        name: str(values, 'name'),
        description: str(values, 'description'),
        autoAddDevices: values['auto-add-devices']
          ? true
          : values['no-auto-add-devices']
            ? false
            : undefined,
        destinationIds:
          destinations === undefined ? undefined : { ids: destinations },
      };
      if (
        request.name === undefined &&
        request.description === undefined &&
        request.autoAddDevices === undefined &&
        request.destinationIds === undefined
      )
        invalid(
          'Supply --name, --description, --destination, --clear-destinations or --[no-]auto-add-devices.',
        );
      return {
        method: 'updateGroup',
        request,
        text: done('Group updated.'),
      };
    },
  },
  'group delete': {
    ...id,
    build: ([groupId]) => ({
      method: 'deleteGroup',
      request: { id: groupId },
      text: done('Group deleted.'),
    }),
  },
  'route list': {
    positionals: [],
    build: () => ({
      method: 'listRoutes',
      request: {},
      text: (response) => table(rows(response.routes).map(routeLine)),
    }),
  },
  'route create': {
    positionals: [],
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      group: { type: 'string' },
      destination: { type: 'string' },
      name: { type: 'string' },
      disabled: { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const type = sourceType(str(values, 'source-type'), [
        'app',
        'channel',
        'any',
      ]);
      if (!type) invalid('Supply --source-type app, channel or any.');
      if (type === 'any' && values.source !== undefined)
        invalid('--source cannot be combined with --source-type any.');
      const to = target(values);
      if (!to) invalid('Supply exactly one of --group or --destination.');
      return {
        method: 'createRoute',
        request: {
          name: str(values, 'name'),
          sourceType: type,
          sourceId: str(values, 'source'),
          kind: str(values, 'kind'),
          ...to,
          enabled: values.disabled ? false : undefined,
        },
        text: (response) =>
          table([routeLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'route update': {
    ...id,
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      'any-source': { type: 'boolean' },
      kind: { type: 'string' },
      'any-kind': { type: 'boolean' },
      group: { type: 'string' },
      destination: { type: 'string' },
      name: { type: 'string' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    build: ([routeId], values) => {
      exclusive(values, 'source', 'any-source');
      exclusive(values, 'kind', 'any-kind');
      const request = {
        id: routeId,
        name: str(values, 'name'),
        sourceType: sourceType(str(values, 'source-type'), [
          'app',
          'channel',
          'any',
        ]),
        // Empty strings clear the filter server-side ("any").
        sourceId: values['any-source'] ? '' : str(values, 'source'),
        kind: values['any-kind'] ? '' : str(values, 'kind'),
        ...target(values),
        enabled: enabledFlag(values),
      };
      if (
        Object.values(request).filter((value) => value !== undefined).length < 2
      )
        invalid('Supply at least one route change.');
      return {
        method: 'updateRoute',
        request,
        text: (response) =>
          table([routeLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'route delete': {
    ...id,
    build: ([routeId]) => ({
      method: 'deleteRoute',
      request: { id: routeId },
      text: done('Route deleted.'),
    }),
  },
  'channel list': {
    positionals: [],
    build: () => ({
      method: 'listChannels',
      request: {},
      text: (response) =>
        table(
          rows(response.channels).map((row) => [
            field(row, 'id'),
            row.enabled === false ? 'disabled' : 'enabled',
            field(row, 'name'),
            rows(row.kinds)
              .map((kind) => field(kind, 'kind'))
              .join(', '),
            field(row, 'pushUrl'),
          ]),
        ),
    }),
  },
  'channel create': {
    positionals: [],
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string', multiple: true },
    },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      const kinds = list(values, 'kind') ?? [];
      if (!name || kinds.length === 0)
        invalid('Supply --name and at least one --kind <kind>[:<name>].');
      return {
        method: 'createChannel',
        request: {
          name,
          description: str(values, 'description'),
          kinds: { kinds: kinds.map(parseKindSpec) },
        },
        text: (response) => channelSecret(response, 'Token'),
      };
    },
  },
  'channel update': {
    ...id,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string', multiple: true },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    build: ([channelId], values) => {
      const kinds = list(values, 'kind');
      const request = {
        id: channelId,
        name: str(values, 'name'),
        description: str(values, 'description'),
        kinds: kinds ? { kinds: kinds.map(parseKindSpec) } : undefined,
        enabled: enabledFlag(values),
      };
      if (
        Object.values(request).filter((value) => value !== undefined).length < 2
      )
        invalid('Supply at least one channel change.');
      return {
        method: 'updateChannel',
        request,
        text: done('Channel updated.'),
      };
    },
  },
  'channel rotate-token': {
    ...id,
    build: ([channelId]) => ({
      method: 'rotateChannelToken',
      request: { id: channelId },
      text: (response) => channelSecret(response, 'New token'),
    }),
  },
  'channel delete': {
    ...id,
    build: ([channelId]) => ({
      method: 'deleteChannel',
      request: { id: channelId },
      text: done('Channel deleted.'),
    }),
  },
};

/** Subcommand groups with their own verbs (`notification route create`). */
const GROUPS = ['destination', 'webhook', 'group', 'route', 'channel'];

const globalFlags = {
  json: { type: 'boolean' },
  profile: { type: 'string' },
  config: { type: 'string' },
  timeout: { type: 'string' },
  workdir: { type: 'string' },
} as const;

export function notificationCommandKeys(): string[] {
  return Object.keys(specs);
}

/**
 * Resolve `args` (the full argv, `offset` at "notification") into one RPC
 * call. Throws `CliError('invalid_arguments')` for any malformed input.
 */
export function parseNotificationCommand(
  args: readonly string[],
  offset: number,
): { call: NotificationCall; values: Values } {
  const first = args[offset + 1];
  const grouped = first !== undefined && GROUPS.includes(first);
  const key = grouped ? `${first} ${args[offset + 2] ?? ''}` : (first ?? '');
  const spec = specs[key];
  if (!spec)
    throw new CliError('unknown_command', 'Unknown command. Use hatch help.');
  const consumed = grouped ? 3 : 2;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + consumed)],
      options: { ...globalFlags, ...spec.options },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    invalid('Invalid notification arguments. Use hatch help notification.');
  }
  const positionals = parsed.positionals;
  if (
    positionals.length !== spec.positionals.length ||
    positionals.some((value) => !value || value.startsWith('-'))
  )
    invalid(
      spec.positionals.length === 0
        ? 'This command takes no positional arguments.'
        : `Supply ${spec.positionals.map((name) => `<${name}>`).join(' ')}.`,
    );
  const values = parsed.values as Values;
  return { call: spec.build(positionals, values), values };
}

/** Execute a resolved call; JSON output is the RPC response in proto JSON. */
export async function executeNotificationCall(
  transport: Transport,
  call: NotificationCall,
): Promise<{ json: JsonValue; text: string }> {
  const client = createClient(
    NotificationService,
    transport,
  ) as unknown as Record<
    Method,
    (request: Record<string, unknown>) => Promise<unknown>
  >;
  const request = Object.fromEntries(
    Object.entries(call.request).filter(([, value]) => value !== undefined),
  );
  const response = await client[call.method](request);
  const json = toJson(
    NotificationService.method[call.method].output,
    response as never,
    { alwaysEmitImplicit: true },
  );
  return {
    json,
    text: call.text(json as Record<string, unknown>),
  };
}

export async function runNotification(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { call, values } = parseNotificationCommand(args, offset);
  const seconds =
    values.timeout === undefined ? 30 : Number(values.timeout as string);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    values.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(values.profile))
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if (values.config === '')
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config as string | undefined),
    values.profile as string | undefined,
  );
  const result = await executeNotificationCall(
    platformTransport(credential, Math.ceil(seconds * 1000), signal),
    call,
  );
  process.stdout.write(
    values.json ? `${JSON.stringify(result.json)}\n` : `${result.text}\n`,
  );
}
