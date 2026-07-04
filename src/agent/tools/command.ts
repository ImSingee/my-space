/** The run_command shell tool with bounded, throttled live output. */
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { MAX_FILE_CHARS, text, tool } from './shared';

/** Bounded tail of a running command's output kept in memory / per update. */
const MAX_LIVE_OUTPUT = 16_000;
/** Per-stream cap on captured stdout/stderr returned to the model. */
const MAX_COMMAND_OUTPUT = MAX_FILE_CHARS;
/** Hard cap on total command output; the child is killed past this. */
const HARD_OUTPUT_LIMIT = 5_000_000;
/** Minimum gap between streamed run_command updates. */
const COMMAND_UPDATE_INTERVAL_MS = 100;

/** Cap a captured stream for the tool result, keeping the (more useful) tail. */
function capCommandStream(label: string, value: string): string | null {
  if (!value) return null;
  if (value.length <= MAX_COMMAND_OUTPUT) return `${label}:\n${value}`;
  return (
    `${label} (truncated to last ${MAX_COMMAND_OUTPUT} chars):\n` +
    value.slice(-MAX_COMMAND_OUTPUT)
  );
}

export function createCommandTool(env: ExecutionEnv): AgentTool {
  return tool({
    name: 'run_command',
    label: 'Run command',
    description:
      'Run a shell command in the workspace root. Use for git, ls, grep, etc.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to run.' }),
    }),
    execute: async (_id, params, signal, onUpdate) => {
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
      const res = await env.exec(wrapShellCommand(params.command), {
        timeout: 120,
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
