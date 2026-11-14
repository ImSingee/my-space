export type CliCommandDefinition = {
  path: readonly string[];
  usage: string;
  description: string;
};

/** Global options accepted by the CLI. */
export const globalOptions = [
  '--json',
  '--profile <name>',
  '--config <path>',
  '--workdir <path>',
  '--timeout <seconds>',
  '--help',
  '--version',
] as const;

const definitions: readonly CliCommandDefinition[] = [
  {
    path: ['help'],
    usage: 'help [command]',
    description: 'Show command help.',
  },
  {
    path: ['version'],
    usage: 'version',
    description: 'Show the CLI version.',
  },
  {
    path: ['auth', 'login'],
    usage: 'auth login [--url <url>] [--no-browser | --api-key-file <path>]',
    description: 'Save a browser-approved session credential.',
  },
  {
    path: ['auth', 'status'],
    usage: 'auth status',
    description: 'Inspect the current credential and identity.',
  },
  {
    path: ['auth', 'logout'],
    usage: 'auth logout [--local-only]',
    description: 'Revoke and remove the selected local login credential.',
  },
  ...(['app', 'workflow'] as const).flatMap((resource) => [
    {
      path: [resource, 'list'],
      usage: `${resource} list`,
      description: `List ${resource} resources.`,
    },
    {
      path: [resource, 'get'],
      usage: `${resource} get <id>`,
      description: `Inspect a ${resource}.`,
    },
    {
      path: [resource, 'create'],
      usage: `${resource} create --file <path|-> [--directory <path>]`,
      description: `Create a ${resource} and its local checkout.`,
    },
    {
      path: [resource, 'clone'],
      usage: `${resource} clone <id> [--directory <path>] [--force]`,
      description: `Clone ${resource} source into a local checkout.`,
    },
    {
      path: [resource, 'update'],
      usage: `${resource} update [--directory <path>]`,
      description: `Refresh a ${resource} checkout while preserving local work.`,
    },
    {
      path: [resource, 'deploy'],
      usage: `${resource} deploy [--directory <path>] [--message <text>] [--allow-destructive-data-migration --data-migration-approval-token <token>] [--reconcile | --retry-after-confirming <commit>]`,
      description: `Deploy a ${resource} checkout.`,
    },
    {
      path: [resource, 'rollback'],
      usage: `${resource} rollback <id> --version <number>`,
      description: `Activate a previous ${resource} deployment.`,
    },
  ]),
  ...(['app', 'workflow'] as const).map((resource) => ({
    path: [resource, 'adopt'],
    usage: `${resource} adopt <id> --directory <path>`,
    description:
      'Attach a verified Agent checkout without discarding source or history.',
  })),
  {
    path: ['app', 'invoke', 'webhook'],
    usage:
      'app invoke webhook <id-or-slug> [--path <relative-suffix>] [--method <HTTP-method>] [--file <path|->] [--content-type <type>] [--header <Name:value>] [--query <name=value>] [--json]',
    description:
      'Call the existing App hook URL once with profile/env credentials. Default POST, empty body, application/octet-stream; --file sends exact bytes. GET/HEAD reject --file. Repeat --header for App-owned headers and --query for encoded query values. Authorization/x-api-key are stripped before App code and cannot carry private auth. Raw response bytes go to stdout (redirect to a file); --json returns ok/status/contentType/bodyEncoding=base64/body. Non-2xx exits nonzero; no retries or redirects.',
  },
  {
    path: ['app', 'associate'],
    usage: 'app associate <id>',
    description:
      'Associate with the verified current Run session, or report not-applicable.',
  },
  {
    path: ['app', 'invoke', 'backend'],
    usage:
      'app invoke backend <id-or-slug> <package.Service/Method> [--file <path|->]',
    description:
      'Invoke an App backend using Connect unary JSON (default request: {}). No streaming or native gRPC.',
  },
  {
    path: ['app', 'kv', 'list'],
    usage:
      'app kv list <app-id> [--cursor <key>] [--limit <count>] [--reveal-secrets]',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'kv', 'get'],
    usage: 'app kv get <app-id> <key> [--reveal-secrets]',
    description: 'Read an App KV entry.',
  },
  {
    path: ['app', 'kv', 'set'],
    usage: 'app kv set <app-id> <key> --file <path|-> [--secret | --no-secret]',
    description: 'Write an App KV entry.',
  },
  {
    path: ['app', 'kv', 'delete'],
    usage: 'app kv delete <app-id> <key>',
    description: 'Delete an App KV entry.',
  },
  {
    path: ['app', 'data-table', 'inspect'],
    usage: 'app data-table inspect <app-id> [--table <name>]',
    description: 'Inspect App Data Table metadata.',
  },
  {
    path: ['app', 'data-table', 'query'],
    usage: 'app data-table query <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'data-table', 'mutate'],
    usage: 'app data-table mutate <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'data-table', 'sql'],
    usage:
      'app data-table sql <app-id> --file <path|-> [--statement-timeout-ms <ms>]',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['app', 'db', 'query'],
    usage: 'app db query <app-id> --file <path|->',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['notification', 'list'],
    usage:
      'notification list [--source-type app|channel|platform] [--source <id>] [--kind <kind>] [--status unrouted|pending|delivered|partial|failed] [--limit <1-100>] [--cursor <id>]',
    description: 'List notifications, newest first.',
  },
  {
    path: ['notification', 'get'],
    usage: 'notification get <id>',
    description:
      'Inspect a notification and every delivery, including App result strings.',
  },
  {
    path: ['notification', 'test'],
    usage: 'notification test <destination-id>',
    description: 'Send a test notification straight to one destination.',
  },
  {
    path: ['notification', 'send'],
    usage:
      'notification send <channel-id> --kind <kind> --title <title> [--body <text>] [--url <url> [--no-auto-open-url]] [--data <json-object>] [--dedupe-key <key>] [--occurred-at <iso-8601>]',
    description:
      'Push a notification as a Channel; routes decide where it is delivered. Tapping it on a phone opens --url unless --no-auto-open-url is set.',
  },
  {
    path: ['notification', 'retry'],
    usage: 'notification retry <delivery-id>',
    description: 'Queue a failed delivery for a fresh series of attempts.',
  },
  {
    path: ['notification', 'sources'],
    usage: 'notification sources',
    description:
      'List Apps and Channels with the notification kinds they declare.',
  },
  {
    path: ['notification', 'destination', 'list'],
    usage: 'notification destination list',
    description: 'List devices, webhooks and App destinations.',
  },
  ...(['enable', 'disable', 'delete'] as const).map((verb) => ({
    path: ['notification', 'destination', verb],
    usage: `notification destination ${verb} <id>`,
    description: `${verb[0].toUpperCase()}${verb.slice(1)} a destination. App destinations can only be enabled or disabled.`,
  })),
  {
    path: ['notification', 'destination', 'rename'],
    usage: 'notification destination rename <id> <name>',
    description: 'Rename a device or webhook destination.',
  },
  {
    path: ['notification', 'webhook', 'create'],
    usage: 'notification webhook create --name <name> --url <url>',
    description: 'Add a webhook destination; prints its signing secret once.',
  },
  {
    path: ['notification', 'webhook', 'update'],
    usage: 'notification webhook update <id> [--name <name>] [--url <url>]',
    description: 'Change a webhook name or URL.',
  },
  {
    path: ['notification', 'webhook', 'rotate-secret'],
    usage: 'notification webhook rotate-secret <id>',
    description: 'Replace a webhook signing secret; prints it once.',
  },
  {
    path: ['notification', 'webhook', 'delete'],
    usage: 'notification webhook delete <id>',
    description: 'Delete a webhook destination.',
  },
  {
    path: ['notification', 'group', 'list'],
    usage: 'notification group list',
    description: 'List destination groups.',
  },
  {
    path: ['notification', 'group', 'create'],
    usage:
      'notification group create --name <name> [--description <text>] [--destination <id>]...',
    description: 'Create a destination group.',
  },
  {
    path: ['notification', 'group', 'update'],
    usage:
      'notification group update <id> [--name <name>] [--description <text>] [--destination <id>... | --clear-destinations]',
    description: 'Change a group; --destination replaces the full member list.',
  },
  {
    path: ['notification', 'group', 'delete'],
    usage: 'notification group delete <id>',
    description: 'Delete a group and the routes that target it.',
  },
  {
    path: ['notification', 'route', 'list'],
    usage: 'notification route list',
    description: 'List routing rules.',
  },
  {
    path: ['notification', 'route', 'create'],
    usage:
      'notification route create --source-type app|channel|any [--source <id>] [--kind <kind>] (--group <id> | --destination <id>) [--name <name>] [--disabled]',
    description:
      'Route matching notifications to a group or one destination. Omit --source/--kind to match any.',
  },
  {
    path: ['notification', 'route', 'update'],
    usage:
      'notification route update <id> [--source-type app|channel|any] [--source <id> | --any-source] [--kind <kind> | --any-kind] [--group <id> | --destination <id>] [--name <name>] [--enable | --disable]',
    description: 'Change a routing rule.',
  },
  {
    path: ['notification', 'route', 'delete'],
    usage: 'notification route delete <id>',
    description: 'Delete a routing rule.',
  },
  {
    path: ['notification', 'channel', 'list'],
    usage: 'notification channel list',
    description: 'List external notification channels and their push URLs.',
  },
  {
    path: ['notification', 'channel', 'create'],
    usage:
      'notification channel create --name <name> [--description <text>] --kind <kind>[:<display name>]...',
    description:
      'Create a channel for external systems; prints its push URL and token once.',
  },
  {
    path: ['notification', 'channel', 'update'],
    usage:
      'notification channel update <id> [--name <name>] [--description <text>] [--kind <kind>[:<display name>]...] [--enable | --disable]',
    description: 'Change a channel; --kind replaces the full kind list.',
  },
  {
    path: ['notification', 'channel', 'rotate-token'],
    usage: 'notification channel rotate-token <id>',
    description: 'Replace a channel token; prints it once.',
  },
  {
    path: ['notification', 'channel', 'delete'],
    usage: 'notification channel delete <id>',
    description: 'Delete a channel and the routes that name it.',
  },
];

export const commandDefinitions = definitions.map((definition) => ({
  ...definition,
  supported: true,
}));
