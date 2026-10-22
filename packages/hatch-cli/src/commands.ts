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
];

export const commandDefinitions = definitions.map((definition) => ({
  ...definition,
  supported: true,
}));
