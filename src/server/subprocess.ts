/**
 * Server-only: bounded subprocess runner shared by the app/workflow builders.
 *
 * Build steps run tools over untrusted, author-controlled sources (buf, deno
 * install/cache/bundle), so every invocation is bounded: a hard timeout stops a
 * hung tool (or a stalled dependency fetch) from wedging a deploy forever, and
 * captured output is capped so a runaway log can't exhaust memory.
 */
import { spawn } from 'node:child_process';

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved in arrival order. */
  output: string;
};

export type RunOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin (stdin is closed either way). */
  input?: string;
  /** Kill the process after this long. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Cap on each captured stream. Defaults to 1MB. */
  maxOutput?: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 1_000_000;

export function run(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;

  /** Append `chunk` to `buf`, stopping once the captured-output cap is hit. */
  const appendCapped = (buf: string, chunk: string): string => {
    if (buf.length >= maxOutput) return buf;
    const next = buf + chunk;
    return next.length > maxOutput
      ? `${next.slice(0, maxOutput)}\n…output truncated…`
      : next;
  };

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let output = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output });
    };
    const timer = setTimeout(() => {
      const note = `\n${cmd} timed out after ${timeoutMs}ms`;
      stderr = appendCapped(stderr, note);
      output = appendCapped(output, note);
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      finish(1);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString();
      stdout = appendCapped(stdout, text);
      output = appendCapped(output, text);
    });
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr = appendCapped(stderr, text);
      output = appendCapped(output, text);
    });
    child.on('error', (err) => {
      const note = `\n${cmd} failed to start: ${err.message}`;
      stderr = appendCapped(stderr, note);
      output = appendCapped(output, note);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 0));
    if (opts.input !== undefined) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}
