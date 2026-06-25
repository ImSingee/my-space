/** Server-only: Agent tool definitions backed by the execution environment. */
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import type {
  AgentTool,
  AgentToolResult,
  ExecutionEnv,
} from '@earendil-works/pi-agent-core';

/** Define a tool while keeping `execute` params typed from its schema. */
function tool<S extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: S;
  execute: (id: string, params: Static<S>) => Promise<AgentToolResult<unknown>>;
}): AgentTool {
  return def as unknown as AgentTool;
}

function text(content: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text: content }], details };
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const MAX_FILE_CHARS = 60000;

export function createTools(env: ExecutionEnv): AgentTool[] {
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
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read.' }),
    }),
    execute: async (_id, params) => {
      const content = unwrap(await env.readTextFile(params.path));
      const truncated = content.length > MAX_FILE_CHARS;
      return text(truncated ? content.slice(0, MAX_FILE_CHARS) : content, {
        path: params.path,
        truncated,
      });
    },
  });

  const writeFile = tool({
    name: 'write_file',
    label: 'Write file',
    description:
      'Create or overwrite a text file (parent directories are created).',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to write.' }),
      content: Type.String({ description: 'Full file contents.' }),
    }),
    execute: async (_id, params) => {
      unwrap(await env.writeFile(params.path, params.content));
      return text(`Wrote ${params.path} (${params.content.length} chars).`, {
        path: params.path,
      });
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
    execute: async (_id, params) => {
      const res = await env.exec(params.command, { timeout: 120 });
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

  const createSubappTool = tool({
    name: 'create_subapp',
    label: 'Create subapp',
    description:
      'Scaffold a new subapp from the platform template. Creates subapps/<id>/ ' +
      'with manifest, proto, Deno backend, React app, and a sample widget.',
    parameters: Type.Object({
      id: Type.String({
        description: 'kebab-case id, e.g. "todo" or "habit-tracker".',
      }),
      name: Type.String({ description: 'Human-readable name.' }),
      description: Type.Optional(
        Type.String({ description: 'One-line description.' }),
      ),
    }),
    execute: async (_id, params) => {
      const { createSubapp } = await import('~server/subapps/scaffold');
      const res = await createSubapp(params);
      return text(
        `Created subapp "${res.id}". Source is at subapps/${res.id}/.\n` +
          'Read the scaffolded files, edit proto/backend/app/widgets, then ' +
          'call deploy_subapp.',
        res,
      );
    },
  });

  const deploySubappTool = tool({
    name: 'deploy_subapp',
    label: 'Deploy subapp',
    description:
      'Build (Connect codegen + bundle app/widgets + stage Deno backend) and ' +
      'deploy a subapp so it becomes live. Reports the app/widget/RPC URLs.',
    parameters: Type.Object({
      id: Type.String({ description: 'Subapp id to deploy.' }),
    }),
    execute: async (_id, params) => {
      const { deploySubapp } = await import('~server/subapps/deploy');
      const res = await deploySubapp(params.id);
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

  const querySubappDb = tool({
    name: 'query_subapp_db',
    label: 'Query subapp DB',
    description:
      "Run SQL against a subapp's own Postgres database (provisioned on first " +
      'use). Use to create tables and inspect data. Returns up to 100 rows.',
    parameters: Type.Object({
      id: Type.String({ description: 'Subapp id.' }),
      sql: Type.String({ description: 'SQL statement to execute.' }),
    }),
    execute: async (_id, params) => {
      const { ensureSubappDatabase } =
        await import('~server/subapps/provision');
      const postgres = (await import('postgres')).default;
      const url = await ensureSubappDatabase(params.id);
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

  return [
    listFiles,
    readFile,
    writeFile,
    runCommand,
    createSubappTool,
    deploySubappTool,
    querySubappDb,
  ];
}
