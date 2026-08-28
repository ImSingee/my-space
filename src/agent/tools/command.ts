/** The run_command shell tool with bounded, throttled live output. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { readEnvFile } from '../env-file';
import { ENV_KEY_PATTERN, requireEnvKey } from '../env-keys';
import { MAX_FILE_CHARS, text, tool } from './shared';

/** Bounded tail of a running command's output kept in memory / per update. */
const MAX_LIVE_OUTPUT = 16_000;
/** Per-stream cap on captured stdout/stderr returned to the model. */
const MAX_COMMAND_OUTPUT = MAX_FILE_CHARS;
/** Hard cap on total command output; the child is killed past this. */
const HARD_OUTPUT_LIMIT = 5_000_000;
/** Minimum gap between streamed run_command updates. */
const COMMAND_UPDATE_INTERVAL_MS = 100;
/** Default command timeout when the Agent does not request an override. */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
/** Keep one tool call bounded even when a longer command is expected. */
const MAX_COMMAND_TIMEOUT_SECONDS = 3600;

export type CommandResultDetails = { exitCode: number };

export function isCommandResultDetails(
  details: unknown,
): details is CommandResultDetails {
  return (
    typeof details === 'object' &&
    details !== null &&
    typeof (details as { exitCode?: unknown }).exitCode === 'number'
  );
}

/** Cap a captured stream for the tool result, keeping the (more useful) tail. */
function capCommandStream(label: string, value: string): string | null {
  if (!value) return null;
  if (value.length <= MAX_COMMAND_OUTPUT) return `${label}:\n${value}`;
  return (
    `${label} (truncated to last ${MAX_COMMAND_OUTPUT} chars):\n` +
    value.slice(-MAX_COMMAND_OUTPUT)
  );
}

function commandTimeoutSeconds(value: number | undefined): number {
  const timeout = value ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_COMMAND_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `timeout_seconds must be an integer between 1 and ` +
        `${MAX_COMMAND_TIMEOUT_SECONDS}.`,
    );
  }
  return timeout;
}

export function createCommandTool(
  env: ExecutionEnv,
  sessionId?: string,
): AgentTool {
  return tool({
    name: 'run_command',
    label: 'Run command',
    description:
      'Run a shell command in the workspace root. Use env_keys to inject only ' +
      'named values previously saved with request_env.',
    selectStreamDetails: (details) =>
      isCommandResultDetails(details) ? details : undefined,
    parameters: Type.Object({
      purpose: Type.String({
        minLength: 1,
        pattern: '\\S',
        description:
          'Very brief purpose for running this command, shown as its UI ' +
          'title. Keep it concise.',
      }),
      command: Type.String({ description: 'Shell command to run.' }),
      timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_COMMAND_TIMEOUT_SECONDS,
          description:
            `Maximum runtime in seconds. Defaults to ` +
            `${DEFAULT_COMMAND_TIMEOUT_SECONDS}. Set this only after a ` +
            'command timed out at the default, or when you already know it ' +
            'is long-running and likely to exceed the default.',
        }),
      ),
      env_keys: Type.Optional(
        Type.Array(
          Type.String({
            pattern: ENV_KEY_PATTERN,
            maxLength: 64,
            description: 'A saved environment key to inject into this command.',
          }),
          { maxItems: 10 },
        ),
      ),
    }),
    execute: async (_id, params, signal, onUpdate) => {
      const timeoutSeconds = commandTimeoutSeconds(params.timeout_seconds);
      const requestedKeys = params.env_keys ?? [];
      if (new Set(requestedKeys).size !== requestedKeys.length) {
        throw new Error('env_keys must be unique.');
      }
      for (const key of requestedKeys) requireEnvKey(key);

      let selectedEnv: Record<string, string> | undefined;
      if (requestedKeys.length > 0) {
        const stored = await readEnvFile(env.cwd);
        const missing = requestedKeys.filter((key) => !stored.has(key));
        if (missing.length > 0) {
          throw new Error(
            `Missing environment keys: ${missing.join(', ')}. ` +
              'Request them with request_env first.',
          );
        }
        selectedEnv = Object.fromEntries(
          requestedKeys.map((key) => [key, stored.get(key)!]),
        );
      }

      // Keep only a bounded tail of the live stream and throttle updates so a
      // chatty command can't grow `live` (and every persisted update event)
      // without bound. Past a hard total, throw from the callback:
      // NodeExecutionEnv catches it, kills the whole process tree, and settles
      // with that error — so a runaway command can't keep filling the env's
      // internal stdout/stderr buffers either.
      let live = '';
      let total = 0;
      let lastEmit = 0;
      const stream = (chunk: string) => {
        total += chunk.length;
        if (total > HARD_OUTPUT_LIMIT) {
          throw new Error(
            `Command exceeded the ${HARD_OUTPUT_LIMIT}-byte output limit; ` +
              'aborted. Redirect bulk output to a file instead.',
          );
        }
        live = (live + chunk).slice(-MAX_LIVE_OUTPUT);
        const now = Date.now();
        if (now - lastEmit >= COMMAND_UPDATE_INTERVAL_MS) {
          lastEmit = now;
          onUpdate?.(live);
        }
      };
      // wrapShellCommand adds the macOS seatbelt deny-list (platform env
      // files, host credential dirs); the env allowlist alone doesn't stop a
      // command from reading those by path.
      const { wrapShellCommand } = await import('../shell-sandbox');
      const res = await env.exec(wrapShellCommand(params.command, sessionId), {
        ...(selectedEnv ? { env: selectedEnv } : {}),
        timeout: timeoutSeconds,
        abortSignal: signal,
        onStdout: stream,
        onStderr: stream,
      });
      if (!res.ok) throw new Error(res.error.message);
      const { stdout, stderr, exitCode } = res.value;
      const body = [
        capCommandStream('stdout', stdout),
        capCommandStream('stderr', stderr),
        `exit code: ${exitCode}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      return text(body, { exitCode });
    },
  });
}
