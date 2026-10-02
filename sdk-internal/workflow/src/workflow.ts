// @ts-self-types="./workflow.d.ts"
/** @hatch/workflow — the SDK a Hatch workflow is written against. */
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
  /** Run an observable, optionally retried unit of work. */
  step<T>(
    name: string,
    fn: () => Promise<T> | T,
    options?: StepOptions,
  ): Promise<T>;
  /** Log a line to the run log. */
  log(...args: unknown[]): void;
};

export type WorkflowDefinition<TInput> = {
  /** Zod schema used for trigger forms and input validation. */
  input?: z.ZodType<TInput>;
  /** The workflow body. Its result must be JSON serializable. */
  run: (ctx: WorkflowContext, input: TInput) => Promise<unknown> | unknown;
};

export function defineWorkflow<TInput = Record<string, never>>(
  definition: WorkflowDefinition<TInput>,
): WorkflowDefinition<TInput> {
  return definition;
}

const SENTINEL = '[[hatch]]';

type DenoRuntime = {
  stdin: { readable: ReadableStream<Uint8Array> };
  env: { get(name: string): string | undefined };
  exit(code?: number): never;
};

function denoRuntime(): DenoRuntime {
  return (globalThis as typeof globalThis & { Deno: DenoRuntime }).Deno;
}

function emit(event: Record<string, unknown>): void {
  console.log(SENTINEL + JSON.stringify(event));
}

function safeValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    if (json.length > 20_000) {
      return { truncated: true, preview: json.slice(0, 20_000) };
    }
    return JSON.parse(json);
  } catch {
    return { unserializable: String(value) };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readStdin(): Promise<string> {
  try {
    return await new Response(denoRuntime().stdin.readable).text();
  } catch {
    return '';
  }
}

function envVar(name: string): string | undefined {
  try {
    return denoRuntime().env.get(name);
  } catch {
    return undefined;
  }
}

/** Entrypoint invoked by the platform-generated bundle wrapper. */
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
      denoRuntime().exit(1);
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
      denoRuntime().exit(1);
    }
    input = parsed.data;
  }

  let sequence = 0;
  const context: WorkflowContext = {
    runId,
    log: (...args: unknown[]) => console.log(...args),
    async step<T>(
      name: string,
      fn: () => Promise<T> | T,
      options?: StepOptions,
    ): Promise<T> {
      const stepSequence = ++sequence;
      const maxAttempts = Math.max(1, options?.retry?.maxAttempts ?? 1);
      const backoffMs = Math.max(0, options?.retry?.backoffMs ?? 0);
      const factor = options?.retry?.factor ?? 2;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = new Date().toISOString();
        emit({
          t: 'step:start',
          seq: stepSequence,
          name,
          attempt,
          startedAt,
        });
        try {
          const output = await fn();
          emit({
            t: 'step:end',
            seq: stepSequence,
            name,
            attempt,
            status: 'succeeded',
            output: safeValue(output),
            startedAt,
            finishedAt: new Date().toISOString(),
          });
          return output;
        } catch (error) {
          lastError = error;
          const willRetry = attempt < maxAttempts;
          emit({
            t: 'step:end',
            seq: stepSequence,
            name,
            attempt,
            status: willRetry ? 'retrying' : 'failed',
            error: errorMessage(error),
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
    const output = await definition.run(context, input);
    emit({ t: 'run:end', status: 'succeeded', output: safeValue(output) });
  } catch (error) {
    emit({
      t: 'run:end',
      status: 'failed',
      error: errorMessage(error),
    });
    denoRuntime().exit(1);
  }
}
