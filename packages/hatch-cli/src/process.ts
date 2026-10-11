import { spawn } from 'node:child_process';
import { CliError } from './error';
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}
export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  allowFailure = false,
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string }> {
  if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: options.env ?? childEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32')
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
        });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, 300000);
    timer.unref();
    if (signal.aborted) kill();
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 300 * 1024 * 1024) kill();
    });
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      reject(
        new CliError(
          signal.aborted ? 'cancelled' : 'tool_unavailable',
          signal.aborted
            ? 'Cancelled.'
            : `Could not run ${executable}. Install the required tool and retry.`,
          signal.aborted ? 130 : 7,
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (process.platform !== 'win32') kill();
      if (signal.aborted)
        reject(
          new CliError('cancelled', 'Cancelled; workspace retained.', 130),
        );
      else if ((code ?? 1) !== 0 && !allowFailure)
        reject(
          new CliError(
            'local_command_failed',
            `${executable} failed. Source was retained; inspect the workspace before retrying.`,
            6,
          ),
        );
      else resolveResult({ code: code ?? 1, stdout: stdout.trim() });
    });
  });
}
export const git = async (
  root: string,
  signal: AbortSignal,
  args: string[],
  allowFailure = false,
) =>
  command(
    'git',
    [
      '-c',
      'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    root,
    signal,
    allowFailure,
  );
