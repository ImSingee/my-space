export type CliCommandDefinition = {
  path: readonly string[];
  usage: string;
  description: string;
};

/** Public command descriptions; unsupported operation/auth surfaces are explicitly reserved. */
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
    path: ['skills', 'list'],
    usage: 'skills list [--json]',
    description:
      'List bundled official product Skills and required files offline.',
  },
  {
    path: ['skills', 'install'],
    usage:
      'skills install [names...] [-s, --skill <name>] [--all] [-l, --list] [--replace] [--recover] [-y, --yes] [--workdir <path>] [--json]',
    description:
      'Install all (default) or selected official Skills and dependencies into .agents/skills. Noninteractive; --yes never implies --replace. --recover restores an interrupted local transaction.',
  },
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
  {
    path: ['auth', 'key', 'list'],
    usage: 'auth key list',
    description: 'Unsupported; list API keys in Settings.',
  },
  {
    path: ['auth', 'key', 'create'],
    usage: 'auth key create --file <path|->',
    description: 'Unsupported; create API keys in Settings.',
  },
  {
    path: ['auth', 'key', 'rotate'],
    usage: 'auth key rotate <credential-id>',
    description: 'Unsupported; there is no atomic key rotation API.',
  },
  {
    path: ['auth', 'key', 'revoke'],
    usage: 'auth key revoke <credential-id>',
    description: 'Unsupported; revoke API keys in Settings.',
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
    path: ['app', 'associate'],
    usage: 'app associate <id>',
    description:
      'Associate with the verified current Run session, or report not-applicable.',
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
    path: ['operation', 'get'],
    usage: 'operation get <operation-id>',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['operation', 'wait'],
    usage: 'operation wait <operation-id>',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
  {
    path: ['operation', 'cancel'],
    usage: 'operation cancel <operation-id>',
    description:
      'Execute the App data operation with domain limits and complete results.',
  },
];

export const commandDefinitions = definitions.map((definition) => {
  const supported =
    ['help', 'version', 'skills'].includes(definition.path[0]) ||
    (definition.path[0] === 'app' &&
      definition.path.length === 3 &&
      ['kv', 'data-table', 'db'].includes(definition.path[1])) ||
    (definition.path.length === 2 &&
      (['app', 'workflow'].includes(definition.path[0]) ||
        (definition.path[0] === 'auth' &&
          ['login', 'status', 'logout'].includes(definition.path[1]))));
  return {
    ...definition,
    supported,
    description: supported
      ? definition.description
      : 'Unsupported; use platform Settings where available. No CLI API contract is provided.',
  };
});
