/** Thin Connect unary JSON client for an App's existing runtime endpoint. */
import type { JsonValue } from '@bufbuild/protobuf';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { configPath, resolveCredential } from './config';
import { credentialHeaders, platformClient, publicError } from './client';
import { CliError } from './error';
import { readTextInput } from './input';

export class BackendInvocationError extends CliError {
  constructor(
    code: string,
    message: string,
    exitCode: number,
    status: number,
    readonly response: unknown,
  ) {
    super(code, message, exitCode, status);
  }
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    for (const secret of secrets)
      value = (value as string).replaceAll(secret, '[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redact(key, secrets),
        redact(entry, secrets),
      ]),
    );
  return value;
}

export async function runBackendInvocation(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      options: {
        json: { type: 'boolean' },
        profile: { type: 'string' },
        config: { type: 'string' },
        timeout: { type: 'string' },
        workdir: { type: 'string' },
        file: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid arguments. Use hatch app invoke --help.',
    );
  }
  const { values, positionals } = parsed;
  const [id, method] = positionals;
  // Protobuf identifiers only: no URLs, encoded separators or dot segments.
  const match =
    /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/.exec(
      method ?? '',
    );
  if (
    args[offset + 2] !== 'backend' ||
    positionals.length !== 2 ||
    !id ||
    id.startsWith('-') ||
    !match ||
    match[0] !== method
  )
    throw new CliError(
      'invalid_arguments',
      'Supply backend <id-or-slug> <package.Service/Method> using Protobuf identifiers.',
    );
  if (
    [values.config, values.workdir, values.file].some(
      (value) => value === '',
    ) ||
    (values.profile !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values.profile))
  )
    throw new CliError(
      'invalid_arguments',
      'Paths must not be empty and profile names must be valid.',
    );
  const seconds = values.timeout === undefined ? 30 : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  const timeout = Math.ceil(seconds * 1000);
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const body =
    values.file === undefined
      ? '{}'
      : await readTextInput(
          values.file === '-'
            ? '-'
            : resolve(values.workdir ?? '.', values.file),
          callSignal,
          1024 * 1024,
          { preserveBOM: true },
        );
  try {
    JSON.parse(body);
  } catch {
    throw new CliError('invalid_input', 'Input must be valid JSON.');
  }
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config),
    values.profile,
  );
  const app = await platformClient(credential, timeout, callSignal).apps.get({
    id,
  });
  // Encode even the management-resolved ID; it can never supply a path segment.
  if (!app.id || app.id === '.' || app.id === '..')
    throw new CliError(
      'invalid_response',
      'The platform returned an invalid App ID.',
      7,
    );
  const target = new URL(
    `/api/app/${encodeURIComponent(app.id)}/rpc/${method}`,
    credential.url,
  );
  const secrets = [credential.token, credential.apiKey].filter(
    (value): value is string => !!value,
  );
  try {
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...credentialHeaders(credential),
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'connect-timeout-ms': String(timeout),
      },
      body,
      signal: callSignal,
    });
    const media = response.headers
      .get('content-type')
      ?.split(';')[0]
      .trim()
      .toLowerCase();
    const version = response.headers.get('connect-protocol-version');
    if (media !== 'application/json' || (version !== null && version !== '1')) {
      // Release a streaming response immediately; an unsupported mode must not
      // keep the CLI alive until the HTTP timeout.
      await response.body?.cancel().catch(() => {});
      throw new CliError(
        'unsupported_protocol',
        'Backend invocation requires Connect unary JSON; streaming and gRPC responses are unsupported.',
        7,
        response.status,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      if (callSignal.aborted) throw callSignal.reason;
      throw new CliError(
        'invalid_response',
        'The backend returned invalid JSON.',
        7,
        response.status,
      );
    }
    if (!response.ok) {
      const safe = redact(result, secrets);
      const fallback = new ConnectError(
        'App backend request failed.',
        Code.Unknown,
      );
      let error: ConnectError;
      try {
        error = errorFromJson(safe as JsonValue, undefined, fallback);
      } catch {
        // An answered request can have an invalid Connect error body. Keep its
        // HTTP status and redacted body instead of treating it as a lost reply.
        error = fallback;
      }
      throw new BackendInvocationError(
        Code[error.code].replace(
          /[A-Z]/g,
          (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`,
        ),
        error.rawMessage,
        publicError(error).exitCode,
        response.status,
        safe,
      );
    }
    process.stdout.write(
      `${JSON.stringify(result, null, values.json ? undefined : 2)}\n`,
    );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (signal.aborted)
      throw new CliError(
        'cancelled',
        'Cancelled. The App method may have run.',
        130,
      );
    throw new CliError(
      'outcome_unknown',
      'Backend request failed or timed out. The App method may have run; inspect its state before retrying.',
      7,
    );
  }
}
