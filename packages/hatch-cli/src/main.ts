import manifest from '../package.json' with { type: 'json' };
import { buildInfo } from '../../../src/build-info';
import { commandDefinitions, globalOptions } from './commands';
import { runAuth } from './auth';
import { runLifecycle } from './lifecycle';
import { runData } from './data';
import { publicError } from './client';
import { refreshRunEnvironment } from './run-credential';
import { CliError } from './error';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const args = process.argv.slice(2);
const json = args.includes('--json');
const output = (value: unknown, text: string) =>
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
function commandOffset() {
  let index = 0;
  while (args[index]?.startsWith('--')) {
    const [flag, inline] = args[index].split('=');
    if (flag === '--json') index++;
    else if (
      ['--profile', '--config', '--timeout', '--workdir'].includes(flag)
    ) {
      if (
        inline === undefined &&
        (!args[index + 1] || args[index + 1].startsWith('--'))
      )
        throw new CliError('invalid_arguments', `Missing value for ${flag}.`);
      index += inline === undefined ? 2 : 1;
    } else break;
  }
  return index;
}
const originalToken = process.env.HATCH_CLI_TOKEN;
try {
  const offset = commandOffset();
  const name = args[offset];
  const operation = args[offset + 1];
  if (['auth', 'app', 'workflow'].includes(name) && !args.includes('--help'))
    await refreshRunEnvironment(process.env, controller.signal);
  if (!name || name === 'help' || args.includes('--help')) {
    const scope =
      name === 'help'
        ? args.slice(offset + 1).filter((part) => !part.startsWith('--'))
        : ['app', 'workflow', 'auth'].includes(name)
          ? [
              name,
              ...(operation && !operation.startsWith('--') ? [operation] : []),
            ]
          : [];
    const commands = commandDefinitions.filter((definition) =>
      scope.every((part, index) => definition.path[index] === part),
    );
    if (!commands.length)
      throw new CliError('unknown_command', 'Unknown command. Use hatch help.');
    output(
      { name: 'hatch', version: manifest.version, commands, globalOptions },
      `Hatch CLI ${manifest.version}\n\n${commands.map((definition) => `${definition.usage}\n  ${definition.description}`).join('\n')}\n\nGlobals: ${globalOptions.join(', ')}\nOperation and API key management are unsupported.`,
    );
  } else if (name === 'version' || name === '--version') {
    if (args.some((arg) => !['version', '--version', '--json'].includes(arg)))
      throw new CliError('invalid_arguments', 'Version accepts only --json.');
    output(
      { version: manifest.version, ...buildInfo },
      `${manifest.version}\nCommit: ${buildInfo.commit?.slice(0, 12) ?? 'Unknown'}\nCommit time: ${buildInfo.commitTime ?? 'Unknown'}`,
    );
  } else if (name === 'auth') {
    if (!['login', 'status', 'logout'].includes(operation))
      throw new CliError(
        'unsupported_command',
        'API key management is available in Settings; this CLI only supports auth login/status/logout.',
        8,
      );
    await runAuth(args, offset, controller.signal);
  } else if (name === 'operation')
    throw new CliError(
      'unsupported_command',
      'Operation commands have no public API contract.',
      8,
    );
  else if (name === 'app' && ['kv', 'data-table', 'db'].includes(operation))
    await runData(args, offset, controller.signal);
  else if (['app', 'workflow'].includes(name))
    await runLifecycle(args, offset, controller.signal);
  else
    throw new CliError(
      'unknown_command',
      'Unknown command. Use hatch help.',
      2,
    );
} catch (error) {
  const known = publicError(error);
  const secrets = [
    originalToken,
    process.env.HATCH_CLI_RUN_SECRET,
    process.env.HATCH_CLI_TOKEN,
    process.env.HATCH_CLI_API_KEY,
  ].filter((value): value is string => !!value);
  let message = known.message;
  for (const secret of secrets)
    message = message.replaceAll(secret, '[redacted]');
  if (json)
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: known.code, message } })}\n`,
    );
  else process.stderr.write(`${message}\n`);
  process.exitCode = known.exitCode;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
