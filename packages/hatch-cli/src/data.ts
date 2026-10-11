/** Strict data commands; arbitrary record values are never normalized. */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { configPath, resolveCredential } from './config';
import { platformClient } from './client';
import { CliError } from './error';
import { readInput, readTextInput } from './input';
import {
  DATA_CALL_BODY_LIMIT,
  type QueryAppKvRequest,
  type QueryAppDataTableRequest,
} from '../../../src/platform-api/data-schemas';

export async function runData(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const surface = args[offset + 1];
  const action = args[offset + 2];
  const allowed =
    surface === 'kv'
      ? ['list', 'get', 'set', 'delete']
      : surface === 'data-table'
        ? ['inspect', 'query', 'mutate', 'sql']
        : ['query'];
  if (!allowed.includes(action))
    throw new CliError(
      'invalid_arguments',
      'Unknown data command. Use hatch help.',
    );
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    json: { type: 'boolean' },
    config: { type: 'string' },
    profile: { type: 'string' },
    workdir: { type: 'string' },
    timeout: { type: 'string' },
  };
  if (['query', 'mutate', 'sql', 'set'].includes(action))
    options.file = { type: 'string' };
  if (surface === 'kv' && ['list', 'get'].includes(action))
    options['reveal-secrets'] = { type: 'boolean' };
  if (surface === 'kv' && action === 'list')
    Object.assign(options, {
      cursor: { type: 'string' },
      limit: { type: 'string' },
    });
  if (surface === 'kv' && action === 'set')
    Object.assign(options, {
      secret: { type: 'boolean' },
      'no-secret': { type: 'boolean' },
    });
  if (action === 'inspect') options.table = { type: 'string' };
  if (action === 'sql') options['statement-timeout-ms'] = { type: 'string' };
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      options,
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid data arguments. Use hatch help.',
    );
  }
  const v = parsed.values;
  const [id, key] = parsed.positionals;
  if (
    !id ||
    parsed.positionals.length !==
      (surface === 'kv' && action !== 'list' ? 2 : 1)
  )
    throw new CliError(
      'invalid_arguments',
      'Supply the App ID and, for KV get/set/delete, exactly one key.',
    );
  if (v.secret && v['no-secret'])
    throw new CliError(
      'invalid_arguments',
      'Use only one of --secret and --no-secret.',
    );
  const statementTimeout =
    v['statement-timeout-ms'] === undefined
      ? 30000
      : Number(v['statement-timeout-ms']);
  const seconds =
    v.timeout === undefined
      ? action === 'sql'
        ? statementTimeout / 1000 + 30
        : surface === 'db'
          ? 60
          : 30
      : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(v.profile))
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if ([v.config, v.workdir, v.file].includes(''))
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, v.config as string | undefined),
    v.profile as string | undefined,
  );
  const client = platformClient(credential, Math.ceil(seconds * 1000), signal);
  const params = { id };
  const inputPath =
    v.file === '-'
      ? '-'
      : v.file === undefined
        ? ''
        : resolve(String(v.workdir ?? '.'), String(v.file));
  let result;
  if (surface === 'kv') {
    let body: QueryAppKvRequest;
    if (action === 'list')
      body = {
        action: 'list',
        ...(v.cursor === undefined ? {} : { cursor: String(v.cursor) }),
        ...(v.limit === undefined ? {} : { limit: Number(v.limit) }),
        revealSecrets: v['reveal-secrets'] === true,
      };
    else if (action === 'get')
      body = {
        action: 'get',
        key,
        revealSecrets: v['reveal-secrets'] === true,
      };
    else if (action === 'delete') body = { action: 'delete', key };
    else
      body = {
        action: 'set',
        key,
        value: await readTextInput(inputPath, signal, 65536),
        ...(v.secret
          ? { secret: true }
          : v['no-secret']
            ? { secret: false }
            : {}),
      };
    result = await client.apps.kv({ params, body });
  } else if (surface === 'db') {
    result = await client.apps.dbQuery({
      params,
      body: {
        sql: await readTextInput(inputPath, signal, DATA_CALL_BODY_LIMIT),
      },
    });
  } else {
    let body: QueryAppDataTableRequest;
    if (action === 'inspect')
      body = {
        action: 'inspect',
        ...(v.table === undefined ? {} : { table: String(v.table) }),
      };
    else if (action === 'sql')
      body = {
        action: 'raw_sql',
        sql: await readTextInput(inputPath, signal, DATA_CALL_BODY_LIMIT),
        timeoutMs: statementTimeout,
      };
    else {
      const input = await readInput(inputPath, signal, DATA_CALL_BODY_LIMIT);
      if (Object.hasOwn(input, 'action'))
        throw new CliError(
          'invalid_input',
          'The command selects action; omit action from the input file.',
        );
      body = { action, ...input } as QueryAppDataTableRequest;
    }
    result = await client.apps.dataTable({ params, body });
  }
  process.stdout.write(
    `${JSON.stringify(result, null, v.json ? undefined : 2)}\n`,
  );
}
