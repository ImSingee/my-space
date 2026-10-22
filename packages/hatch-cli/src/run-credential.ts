/** Resolve a current credential at CLI process startup, even in a long shell. */
import { CliError } from './error';

export async function refreshRunEnvironment(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  if (
    env.HATCH_CLI_RUN_ENDPOINT === undefined &&
    env.HATCH_CLI_RUN_SECRET === undefined
  )
    return;
  try {
    const endpoint = new URL(env.HATCH_CLI_RUN_ENDPOINT ?? '');
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      !endpoint.port ||
      endpoint.pathname !== '/credential' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^[a-f0-9]{64}$/.test(env.HATCH_CLI_RUN_SECRET ?? '') ||
      !env.HATCH_CLI_TOKEN ||
      env.HATCH_CLI_API_KEY !== undefined
    )
      throw new Error();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.HATCH_CLI_RUN_SECRET}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error();
    const value = await response.json();
    if (
      typeof value.token !== 'string' ||
      !/^\S{1,8192}$/.test(value.token) ||
      typeof value.url !== 'string' ||
      value.url !== env.HATCH_CLI_URL
    )
      throw new Error();
    env.HATCH_CLI_TOKEN = value.token;
  } catch {
    throw new CliError(
      'run_credentials_unavailable',
      'Run CLI credentials are unavailable. Start a new command after the Runner reconnects.',
      3,
    );
  }
}
