/** Thin plain-HTTP invocation of the existing App webhook runtime endpoint. */
import type { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { credentialHeaders, platformClient } from './client';
import { configPath, resolveCredential } from './config';
import { CliError } from './error';

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function hasControl(value: string) {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function webhookSuffix(value = ''): string {
  if (!value) return '';
  if (
    /[%?#\\:\s]/u.test(value) ||
    hasControl(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new CliError(
      'invalid_path',
      '--path must be relative segments without traversal, URL syntax or percent escapes. Use --query name=value for query parameters.',
    );
  return `/${value.split('/').map(encodeURIComponent).join('/')}`;
}

export function webhookHeaders(values: string[] = []): Headers {
  const headers = new Headers();
  for (const value of values) {
    const colon = value.indexOf(':');
    const name = value.slice(0, colon).trim().toLowerCase();
    if (
      colon <= 0 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) ||
      hasControl(value) ||
      name.startsWith('x-hatch-') ||
      name.startsWith('x-forwarded-') ||
      [
        'authorization',
        'x-api-key',
        'cookie',
        'host',
        'origin',
        'content-length',
        'content-type',
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'forwarded',
        'via',
      ].includes(name) ||
      name.startsWith('sec-')
    )
      throw new CliError(
        'invalid_header',
        'Use an App-owned nonreserved header (for example X-App-Token). Platform credential/routing headers cannot be overridden; Authorization and x-api-key are stripped before the App handler. Use --content-type for media type.',
      );
    try {
      headers.append(name, value.slice(colon + 1).trim());
    } catch {
      throw new CliError('invalid_header', 'Invalid HTTP header.');
    }
  }
  return headers;
}

export async function runWebhook(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  if (args[offset + 2] !== 'webhook')
    throw new CliError('invalid_arguments', 'Use hatch app invoke webhook.');
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        profile: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'string' },
        path: { type: 'string' },
        method: { type: 'string' },
        file: { type: 'string' },
        'content-type': { type: 'string' },
        header: { type: 'string', multiple: true },
        query: { type: 'string', multiple: true },
      },
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid webhook arguments. Use hatch help app invoke webhook.',
    );
  }
  const v = parsed.values;
  const [id] = parsed.positionals;
  if (!id || parsed.positionals.length !== 1)
    throw new CliError(
      'invalid_arguments',
      'Supply exactly one App ID or slug.',
    );
  const method = (v.method ?? 'POST').toUpperCase();
  if (!methods.includes(method))
    throw new CliError(
      'invalid_method',
      `Supported methods: ${methods.join(', ')}.`,
    );
  if (['GET', 'HEAD'].includes(method) && v.file !== undefined)
    throw new CliError('invalid_body', 'GET/HEAD cannot include --file.');
  const suffix = webhookSuffix(v.path);
  const headers = webhookHeaders(v.header);
  try {
    headers.set(
      'content-type',
      v['content-type'] ?? 'application/octet-stream',
    );
    if (!headers.get('content-type')) throw new Error();
  } catch {
    throw new CliError(
      'invalid_content_type',
      'Supply a valid nonempty --content-type.',
    );
  }
  const query = new URLSearchParams();
  for (const pair of v.query ?? []) {
    const equals = pair.indexOf('=');
    if (equals < 1)
      throw new CliError(
        'invalid_query',
        '--query requires name=value. Repeat it for multiple values.',
      );
    query.append(pair.slice(0, equals), pair.slice(equals + 1));
  }
  const seconds = v.timeout === undefined ? 30 : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if ([v.config, v.workdir, v.file].includes(''))
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, v.config),
    v.profile,
  );
  const timeout = Math.ceil(seconds * 1000);
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  const app = await platformClient(credential, timeout, callSignal).apps.get({
    id,
  });
  // Resolve IDs/slugs through management RPC, then target only that canonical
  // App's runtime endpoint. Never read or request its webhook secret.
  const url = new URL(
    `${credential.url}/api/app/${encodeURIComponent(app.id)}/hook${suffix}`,
  );
  url.search = query.toString();
  for (const [name, value] of Object.entries(credentialHeaders(credential)))
    headers.set(name, value);
  let input:
    | ReturnType<typeof createReadStream>
    | typeof process.stdin
    | undefined;
  if (v.file === '-') {
    if (process.stdin.isTTY)
      throw new CliError(
        'stdin_required',
        'Pipe raw bytes or redirect a file for --file -.',
      );
    input = process.stdin;
  } else if (v.file !== undefined) {
    const path = resolve(v.workdir ?? '.', v.file);
    let file;
    try {
      file = await open(path, 'r');
      if (!(await file.stat()).isFile()) throw new Error();
      input = file.createReadStream();
    } catch {
      await file?.close();
      throw new CliError('input_unreadable', 'Cannot read input file.');
    }
  }
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      redirect: 'error',
      signal: callSignal,
      ...(input ? { body: input as unknown as BodyInit, duplex: 'half' } : {}),
    };
    const response = await fetch(url, init);
    if (v.json) {
      const body = Buffer.from(await response.arrayBuffer());
      process.stdout.write(
        `${JSON.stringify({
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodyEncoding: 'base64',
          body: body.toString('base64'),
        })}\n`,
      );
    } else if (response.body) {
      // Raw bytes go only to stdout; shell redirection can save binary output.
      for await (const chunk of response.body) {
        if (!process.stdout.write(chunk))
          await once(process.stdout, 'drain', { signal: callSignal });
      }
    }
    if (!response.ok) {
      if (!v.json)
        process.stderr.write(`Webhook returned HTTP ${response.status}.\n`);
      process.exitCode =
        response.status === 401
          ? 3
          : response.status === 403
            ? 4
            : response.status === 404
              ? 5
              : 7;
    }
  } catch {
    if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
    throw new CliError(
      'outcome_unknown',
      'Webhook request failed, redirected or timed out. Its outcome may be unknown; inspect App state before retrying.',
      7,
    );
  } finally {
    input?.destroy();
  }
}
