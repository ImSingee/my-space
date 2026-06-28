/**
 * @hatch/workflow — the tiny SDK a Hatch workflow is written against.
 *
 * This file is platform-managed: it is bundled into the workflow's single-file
 * program at deploy time and provides `defineWorkflow` plus the runner the
 * platform invokes. Do not edit it — write your workflow in `workflow.ts`.
 */
import { z } from 'zod';

export type RetryOptions = {
  /** Total attempts including the first try (default 1 = no retry). */
  maxAttempts?: number;
  /** Delay before the first retry, in ms (default 0). */
  backoffMs?: number;
  /** Multiplier applied to the delay after each failed attempt (default 2). */
  factor?: number;
};

export type StepOptions = {
  retry?: RetryOptions;
};

export type WorkflowContext = {
  /** Stable id of the current run, for correlating external logs. */
  readonly runId: string;
  /**
   * Run an observable, optionally-retried step. The platform records each
   * step's start/finish (and every retry) and shows them in the run inspector.
   * Use steps for the meaningful units of work so failures are easy to locate.
   */
  step<T>(
    name: string,
    fn: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  /** Log a line to the run log (visible in the inspector). */
  log(...args: unknown[]): void;
};

export type WorkflowDefinition<TInput> = {
  /**
   * zod schema describing the trigger input. Persisted as JSON Schema on deploy
   * and used to render the manual-run form and validate every trigger.
   */
  input?: z.ZodType<TInput>;
  /** The workflow body. Return a JSON-serializable result. */
  run: (ctx: WorkflowContext, input: TInput) => Promise<unknown> | unknown;
};

export function defineWorkflow<TInput = Record<string, never>>(
  definition: WorkflowDefinition<TInput>,
): WorkflowDefinition<TInput> {
  return definition;
}

/* ----------------------------- runner internals --------------------------- */

const SENTINEL = '[[hatch]]';

/**
 * Structured events share stdout with user logs. The platform parses lines
 * prefixed with the sentinel as events and treats everything else as run log.
 */
function emit(event: Record<string, unknown>): void {
  console.log(SENTINEL + JSON.stringify(event));
}

/** JSON-safe snapshot of a value, truncated to keep events small. */
function safeValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    if (json.length > 20000) {
      return { truncated: true, preview: json.slice(0, 20000) };
    }
    return JSON.parse(json);
  } catch {
    return { unserializable: String(value) };
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readStdin(): Promise<string> {
  try {
    return await new Response(Deno.stdin.readable).text();
  } catch {
    return '';
  }
}

function envVar(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Entrypoint invoked by the generated bundle wrapper. Dispatches on HATCH_MODE:
 * - "describe": print the input JSON Schema and exit.
 * - "run" (default): read input from stdin, validate, run, stream events.
 */
export async function runCli(
  definition: WorkflowDefinition<unknown>,
): Promise<void> {
  const mode = envVar('HATCH_MODE') ?? 'run';

  if (mode === 'describe') {
    let schema: unknown = {
      type: 'object',
      properties: {},
      additionalProperties: true,
    };
    if (definition.input) {
      try {
        schema = z.toJSONSchema(definition.input, { io: 'input' });
      } catch {
        schema = z.toJSONSchema(definition.input);
      }
    }
    emit({ t: 'schema', schema });
    return;
  }

  const runId = envVar('HATCH_RUN_ID') ?? '';
  const raw = await readStdin();
  let input: unknown = {};
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      emit({
        t: 'run:end',
        status: 'failed',
        error: 'Run input was not valid JSON.',
      });
      Deno.exit(1);
    }
  }

  if (definition.input) {
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) {
      emit({
        t: 'run:end',
        status: 'failed',
        error:
          'Input validation failed: ' + JSON.stringify(parsed.error.issues),
      });
      Deno.exit(1);
    }
    input = parsed.data;
  }

  let seq = 0;
  const ctx: WorkflowContext = {
    runId,
    log: (...args: unknown[]) => console.log(...args),
    async step<T>(
      name: string,
      fn: () => Promise<T> | T,
      options?: StepOptions,
    ): Promise<T> {
      const mySeq = ++seq;
      const maxAttempts = Math.max(1, options?.retry?.maxAttempts ?? 1);
      const backoffMs = Math.max(0, options?.retry?.backoffMs ?? 0);
      const factor = options?.retry?.factor ?? 2;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date().toISOString();
        emit({ t: 'step:start', seq: mySeq, name, attempt, startedAt });
        try {
          const out = await fn();
          emit({
            t: 'step:end',
            seq: mySeq,
            name,
            attempt,
            status: 'succeeded',
            output: safeValue(out),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          return out;
        } catch (err) {
          lastError = err;
          const willRetry = attempt < maxAttempts;
          emit({
            t: 'step:end',
            seq: mySeq,
            name,
            attempt,
            status: willRetry ? 'retrying' : 'failed',
            error: errMessage(err),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          if (willRetry && backoffMs > 0) {
            await sleep(backoffMs * Math.pow(factor, attempt - 1));
          }
        }
      }
      throw lastError;
    },
  };

  emit({ t: 'run:start', startedAt: new Date().toISOString() });
  try {
    const output = await definition.run(ctx, input);
    emit({ t: 'run:end', status: 'succeeded', output: safeValue(output) });
  } catch (err) {
    emit({ t: 'run:end', status: 'failed', error: errMessage(err) });
    Deno.exit(1);
  }
}
