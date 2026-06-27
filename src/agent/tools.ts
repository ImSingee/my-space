/** Server-only: Agent tool definitions backed by the execution environment. */
import path from 'node:path';
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import type {
  AgentTool,
  AgentToolResult,
  ExecutionEnv,
} from '@earendil-works/pi-agent-core';
import type { AskAnswer, AskQuestion } from './events';

/**
 * Bridge supplied by the runtime so the `ask` tool can surface a question to the
 * chat UI and block until the user replies. Resolves with the user's answers.
 */
export type AskBridge = (
  questions: AskQuestion[],
  signal?: AbortSignal,
) => Promise<AskAnswer[]>;

export type CreateToolsOptions = {
  ask?: AskBridge;
  sessionId?: string;
};

/** Define a tool while keeping `execute` params typed from its schema. */
function tool<S extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: S;
  executionMode?: AgentTool['executionMode'];
  execute: (
    id: string,
    params: Static<S>,
    signal?: AbortSignal,
    /** Stream partial output while the tool is still running. */
    onUpdate?: (partial: unknown) => void,
  ) => Promise<AgentToolResult<unknown>>;
}): AgentTool {
  return def as unknown as AgentTool;
}

/** Render the user's answers as readable text for the model to consume. */
function formatAskAnswers(
  questions: AskQuestion[],
  answers: AskAnswer[],
): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const lines = questions.map((q) => {
    const answer = byId.get(q.id);
    const labels = (answer?.selectedOptionIds ?? [])
      .map((oid) => q.options.find((o) => o.id === oid)?.label)
      .filter((label): label is string => Boolean(label));
    if (answer?.customText) labels.push(answer.customText.trim());
    const value = labels.length > 0 ? labels.join(', ') : '(no answer)';
    return `Q: ${q.prompt}\nA: ${value}`;
  });
  return lines.join('\n\n');
}

function text(content: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error('This tool requires an Agent session id.');
  }
  return sessionId;
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const MAX_FILE_CHARS = 60000;

function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function toWorkspacePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index < 0) return count;
    count += 1;
    index += needle.length;
  }
}

function applyExactReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; count: number } {
  if (!oldString) throw new Error('old_string must not be empty.');
  if (oldString === newString) {
    throw new Error('old_string and new_string are identical.');
  }
  const count = countOccurrences(content, oldString);
  if (count === 0) {
    throw new Error('old_string was not found in the current file.');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matched ${count} times. Provide a shorter unique ` +
        'old_string, or set replace_all to true.',
    );
  }
  const index = content.indexOf(oldString);
  return {
    updated: replaceAll
      ? content.split(oldString).join(newString)
      : `${content.slice(0, index)}${newString}${content.slice(
          index + oldString.length,
        )}`,
    count: replaceAll ? count : 1,
  };
}

async function canonicalWorkspaceRoot(
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<string> {
  return unwrap(await env.canonicalPath('.', signal));
}

async function resolveExistingTextFile(
  env: ExecutionEnv,
  inputPath: string,
  signal?: AbortSignal,
): Promise<{ workspacePath: string; canonicalPath: string }> {
  const [root, canonicalPath] = await Promise.all([
    canonicalWorkspaceRoot(env, signal),
    unwrap(await env.canonicalPath(inputPath, signal)),
  ]);
  if (!isInsidePath(root, canonicalPath)) {
    throw new Error(`${inputPath} is outside the workspace.`);
  }
  const info = unwrap(await env.fileInfo(canonicalPath, signal));
  if (info.kind !== 'file') {
    throw new Error(`${inputPath} is not a regular file.`);
  }
  return {
    workspacePath: toWorkspacePath(root, canonicalPath),
    canonicalPath,
  };
}

async function resolveWritableTextFile(
  env: ExecutionEnv,
  inputPath: string,
  signal?: AbortSignal,
): Promise<{ workspacePath: string }> {
  const root = await canonicalWorkspaceRoot(env, signal);
  const addressedRoot = unwrap(await env.absolutePath('.', signal));
  const absolutePath = unwrap(await env.absolutePath(inputPath, signal));

  const exists = unwrap(await env.exists(absolutePath, signal));
  if (exists) {
    const existing = await resolveExistingTextFile(env, absolutePath, signal);
    return { workspacePath: existing.workspacePath };
  }

  let parent = path.dirname(absolutePath);
  while (!unwrap(await env.exists(parent, signal))) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }

  const parentInfo = unwrap(await env.fileInfo(parent, signal));
  if (parentInfo.kind !== 'directory') {
    throw new Error(`Parent path for ${inputPath} is not a directory.`);
  }
  const canonicalParent = unwrap(await env.canonicalPath(parent, signal));
  if (!isInsidePath(root, canonicalParent)) {
    throw new Error(`${inputPath} is outside the workspace.`);
  }

  if (isInsidePath(root, absolutePath)) {
    return { workspacePath: toWorkspacePath(root, absolutePath) };
  }
  if (isInsidePath(addressedRoot, absolutePath)) {
    return { workspacePath: toWorkspacePath(addressedRoot, absolutePath) };
  }
  throw new Error(`${inputPath} is outside the workspace.`);
}

export function createTools(
  env: ExecutionEnv,
  options: CreateToolsOptions = {},
): AgentTool[] {
  const listFiles = tool({
    name: 'list_files',
    label: 'List files',
    description:
      'List files and directories at a path (relative to the workspace root).',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Directory path. Defaults to ".".' }),
      ),
    }),
    execute: async (_id, params) => {
      const entries = unwrap(await env.listDir(params.path ?? '.'));
      const lines = entries
        .map((e) => `${e.kind === 'directory' ? 'd' : '-'} ${e.name}`)
        .sort();
      return text(lines.join('\n') || '(empty)', { count: entries.length });
    },
  });

  const readFile = tool({
    name: 'read_file',
    label: 'Read file',
    description: 'Read a UTF-8 text file relative to the workspace root.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read.' }),
    }),
    execute: async (_id, params, signal) => {
      const resolved = await resolveExistingTextFile(env, params.path, signal);
      const content = unwrap(await env.readTextFile(params.path, signal));
      const truncated = content.length > MAX_FILE_CHARS;
      return text(truncated ? content.slice(0, MAX_FILE_CHARS) : content, {
        path: resolved.workspacePath,
        truncated,
      });
    },
  });

  const writeFile = tool({
    name: 'write_file',
    label: 'Write file',
    description:
      'Create or overwrite a text file (parent directories are created).',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to write.' }),
      content: Type.String({ description: 'Full file contents.' }),
    }),
    execute: async (_id, params, signal) => {
      const writable = await resolveWritableTextFile(env, params.path, signal);
      unwrap(await env.writeFile(params.path, params.content, signal));
      return text(
        `Wrote ${writable.workspacePath} (${params.content.length} chars).`,
        {
          path: writable.workspacePath,
        },
      );
    },
  });

  const editFile = tool({
    name: 'edit_file',
    label: 'Edit file',
    description:
      'Edit an existing UTF-8 text file by replacing an exact string. ' +
      'Read the file first so old_string can be copied exactly.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to edit.' }),
      old_string: Type.String({
        description:
          'Exact text to replace. Keep it as short as possible while unique.',
      }),
      new_string: Type.String({ description: 'Replacement text.' }),
      replace_all: Type.Optional(
        Type.Boolean({
          description: 'Replace every occurrence of old_string.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const resolved = await resolveExistingTextFile(env, params.path, signal);
      const content = unwrap(
        await env.readTextFile(resolved.canonicalPath, signal),
      );
      const { updated, count } = applyExactReplacement(
        content,
        params.old_string,
        params.new_string,
        params.replace_all ?? false,
      );
      unwrap(await env.writeFile(resolved.canonicalPath, updated, signal));
      return text(
        `Edited ${resolved.workspacePath}: replaced ${count} occurrence(s).`,
        {
          path: resolved.workspacePath,
          replacements: count,
        },
      );
    },
  });

  const runCommand = tool({
    name: 'run_command',
    label: 'Run command',
    description:
      'Run a shell command in the workspace root. Use for git, ls, grep, etc.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to run.' }),
    }),
    execute: async (_id, params, signal, onUpdate) => {
      let live = '';
      const stream = (chunk: string) => {
        live += chunk;
        onUpdate?.(live);
      };
      const res = await env.exec(params.command, {
        timeout: 120,
        abortSignal: signal,
        onStdout: stream,
        onStderr: stream,
      });
      if (!res.ok) throw new Error(res.error.message);
      const { stdout, stderr, exitCode } = res.value;
      const body = [
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
        `exit code: ${exitCode}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      return text(body, { exitCode });
    },
  });

  const listAppsTool = tool({
    name: 'list_apps',
    label: 'List apps',
    description:
      'List every app on the platform with its status, live version, and ' +
      'enabled capabilities. Use this to discover existing apps before ' +
      'calling get_app or checkout_app.',
    parameters: Type.Object({}),
    execute: async () => {
      const { listAppsForAgent } = await import('~server/apps/inspect');
      const apps = await listAppsForAgent();
      if (apps.length === 0) {
        return text('No apps exist yet.', { apps });
      }
      const lines = apps.map((a) => {
        const version =
          a.currentVersion != null
            ? ` v${a.currentVersion}`
            : ' (not deployed)';
        const caps =
          a.capabilities.length > 0 ? ` — ${a.capabilities.join(', ')}` : '';
        return `- ${a.id} · ${a.name} [${a.status}]${version}${caps}`;
      });
      return text(lines.join('\n'), { apps });
    },
  });

  const getAppTool = tool({
    name: 'get_app',
    label: 'Get app details',
    description:
      "Get one app's details: status, live version, capabilities, the " +
      'normalized manifest (app/widget/RPC/webhook/storage URLs), runtime ' +
      'state (backend running, cron jobs), and deployment history. Mirrors ' +
      'the app management panel.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id to inspect.' }),
    }),
    execute: async (_id, params) => {
      const { getAppDetailForAgent } = await import('~server/apps/inspect');
      const detail = await getAppDetailForAgent(params.id);
      if (!detail) throw new Error(`App "${params.id}" not found.`);
      const m = detail.manifest;
      const lines: (string | null)[] = [
        `${detail.name} (${detail.id}) — ${detail.status}` +
          (detail.currentVersion != null
            ? ` · v${detail.currentVersion}`
            : ' · not deployed'),
        detail.description ? `Description: ${detail.description}` : null,
        `Backend: ${
          detail.ops.backend.capable
            ? `${detail.backendMode ?? 'serverless'}${
                detail.ops.backend.running ? ' (running)' : ''
              }`
            : 'none'
        }`,
        `Database: ${detail.dbName ?? 'not provisioned'}`,
        `Capabilities: ${
          detail.capabilities.length > 0
            ? detail.capabilities.join(', ')
            : 'none detected yet'
        }`,
        m?.app ? `App URL: ${m.app.url}` : null,
        m?.rpc ? `RPC: ${m.rpc.url} (${m.rpc.service})` : null,
        m && m.widgets.length > 0
          ? `Widgets: ${m.widgets.map((w) => `${w.id} (${w.url})`).join(', ')}`
          : null,
        detail.ops.webhook.enabled
          ? `Webhook: ${detail.ops.webhook.url ?? 'n/a'}${
              detail.ops.webhook.hasSecret ? ' [secret set]' : ''
            }`
          : null,
        detail.ops.storage.enabled
          ? `Storage: ${detail.ops.storage.url ?? 'n/a'} (${
              detail.ops.storage.objectCount
            } object(s))`
          : null,
        detail.ops.cron.enabled
          ? `Cron: ${
              detail.ops.cron.jobs.length > 0
                ? detail.ops.cron.jobs
                    .map((j) => `${j.name} [${j.schedule}]`)
                    .join(', ')
                : 'no jobs'
            }`
          : null,
        '',
        'Deployments (newest first):',
        ...detail.deployments
          .slice(0, 10)
          .map(
            (d) =>
              `  v${d.version} — ${d.status}${d.isCurrent ? ' (current)' : ''}${
                d.canRollback ? ' [rollbackable]' : ''
              } · ${d.createdAt}`,
          ),
      ];
      return text(lines.filter((l) => l !== null).join('\n'), detail);
    },
  });

  const checkoutAppTool = tool({
    name: 'checkout_app',
    label: 'Checkout app',
    description:
      "Checkout an app's Git repo into this chat's persistent worktree. " +
      'Use before reading or editing an existing app.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id to checkout.' }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const { checkoutAppForAgent } = await import('~server/apps/git');
      const checkout = await checkoutAppForAgent(sessionId, params.id);
      const lines = [
        `Checked out "${params.id}" at ${checkout.path}/.`,
        checkout.headCommit
          ? `HEAD: ${checkout.headCommit}`
          : 'No commits yet. Create files, then run git add and git commit.',
        checkout.remoteCommit
          ? `Remote master: ${checkout.remoteCommit}`
          : 'Remote master has no commits yet.',
        checkout.dirty
          ? `Worktree has local changes:\n${checkout.status}`
          : 'Worktree is clean.',
      ];
      return text(lines.join('\n'), checkout);
    },
  });

  const createAppTool = tool({
    name: 'create_app',
    label: 'Create app',
    description:
      "Scaffold a new app from the platform template in this chat's " +
      'worktree with manifest, proto, Deno backend, React app, and a sample ' +
      'widget.',
    parameters: Type.Object({
      id: Type.String({
        description: 'kebab-case id, e.g. "todo" or "habit-tracker".',
      }),
      name: Type.String({ description: 'Human-readable name.' }),
      description: Type.Optional(
        Type.String({ description: 'One-line description.' }),
      ),
      pin: Type.Optional(
        Type.Boolean({
          description:
            'Pin the app to the sidebar. Pass true when the app will have a ' +
            'user-facing frontend (the default) so it is reachable right away, ' +
            'and false for backend-only or widget-only apps.',
        }),
      ),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const { createApp } = await import('~server/apps/scaffold');
      const res = await createApp(params, { sessionId });
      return text(
        `Created app "${res.id}". Source is at ${res.id}/.\n` +
          'Read the scaffolded files, edit proto/backend/app/widgets, then ' +
          'commit your changes with git before calling deploy_app.',
        res,
      );
    },
  });

  const deployAppTool = tool({
    name: 'deploy_app',
    label: 'Deploy app',
    description:
      'Build (Connect codegen + bundle app/widgets + stage Deno backend) and ' +
      'deploy an app so it becomes live. Reports the app/widget/RPC URLs.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id to deploy.' }),
      message: Type.String({
        description:
          'Required release note describing what this deployment changes ' +
          '(e.g. "Add dark mode toggle"). Shown in the deployment history.',
      }),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      const { agentAppWorkDir } = await import('~agent/paths');
      const { deployApp } = await import('~server/apps/deploy');
      const res = await deployApp(params.id, {
        sourceDir: agentAppWorkDir(sessionId, params.id),
        message: params.message,
      });
      const lines = [
        `Deployed "${params.id}" (v${res.version}).`,
        res.normalized.app ? `App (iframe): ${res.normalized.app.url}` : null,
        res.normalized.widgets.length > 0
          ? `Widgets: ${res.normalized.widgets.map((w) => w.id).join(', ')}`
          : null,
        res.normalized.rpc ? `RPC: ${res.normalized.rpc.url}` : null,
      ].filter(Boolean);
      return text(lines.join('\n'), res);
    },
  });

  const rollbackAppTool = tool({
    name: 'rollback_app',
    label: 'Rollback app',
    description:
      'Rollback an app to a previous deployment version. Restores that ' +
      "version's artifact and moves the app repo master branch to its " +
      'deployment tag commit. Pass the version number shown by get_app ' +
      '(e.g. 4 to restore v4); only successfully deployed versions can be ' +
      'restored.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id to rollback.' }),
      version: Type.Number({
        description: 'Deployment version to restore, e.g. 4 for v4.',
      }),
    }),
    execute: async (_id, params) => {
      const { rollbackAppToVersion } = await import('~server/apps/manage');
      const res = await rollbackAppToVersion(params.id, params.version);
      return text(
        `Rolled back "${params.id}" to v${res.version}. ` +
          'Run checkout_app or git fetch/rebase in existing worktrees before ' +
          'making more changes.',
        res,
      );
    },
  });

  const queryAppDb = tool({
    name: 'query_app_db',
    label: 'Query app DB',
    description:
      "Run SQL against an app's own Postgres database (provisioned on first " +
      'use). Use to create tables and inspect data. Returns up to 100 rows.',
    parameters: Type.Object({
      id: Type.String({ description: 'App id.' }),
      sql: Type.String({ description: 'SQL statement to execute.' }),
    }),
    execute: async (_id, params) => {
      const { ensureAppDatabase } = await import('~server/apps/provision');
      const postgres = (await import('postgres')).default;
      const url = await ensureAppDatabase(params.id);
      const sql = postgres(url, { max: 1 });
      try {
        const rows = await sql.unsafe(params.sql);
        const body =
          rows.length > 0
            ? JSON.stringify(rows.slice(0, 100), null, 2)
            : `OK (${rows.count} row(s) affected).`;
        return text(body, { rowCount: rows.length });
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  });

  const askBridge = options.ask;
  const askUser = tool({
    name: 'ask',
    label: 'Ask the user',
    description:
      'Ask the user a multiple-choice question when you are blocked on a ' +
      'decision only they can make — ambiguous requirements, a trade-off ' +
      'between approaches, or missing information you cannot infer. Prefer ' +
      'this over guessing for consequential choices, but do NOT use it for ' +
      'things you can reasonably decide yourself. Each question needs at ' +
      'least two options; the user can also type a custom answer. Returns the ' +
      "user's selections so you can continue.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          prompt: Type.String({ description: 'The question to ask.' }),
          options: Type.Array(
            Type.Object({
              label: Type.String({
                description: 'A choice the user can pick.',
              }),
            }),
            { description: 'Two or more options.' },
          ),
          allowMultiple: Type.Optional(
            Type.Boolean({
              description: 'Allow selecting more than one option.',
            }),
          ),
        }),
        { description: 'One or more questions to ask at once.' },
      ),
    }),
    execute: async (_id, params, signal) => {
      if (!askBridge) throw new Error('Asking the user is not available here.');
      if (params.questions.length === 0) {
        throw new Error('Provide at least one question.');
      }
      const questions: AskQuestion[] = params.questions.map((q, qi) => ({
        id: `q${qi + 1}`,
        prompt: q.prompt,
        options: q.options.map((o, oi) => ({
          id: `o${oi + 1}`,
          label: o.label,
        })),
        allowMultiple: q.allowMultiple ?? false,
      }));
      const answers = await askBridge(questions, signal);
      return text(formatAskAnswers(questions, answers), { questions, answers });
    },
  });

  const tools = [
    listFiles,
    readFile,
    editFile,
    writeFile,
    runCommand,
    listAppsTool,
    getAppTool,
    checkoutAppTool,
    createAppTool,
    deployAppTool,
    rollbackAppTool,
    queryAppDb,
  ];
  if (askBridge) tools.push(askUser);
  return tools;
}
