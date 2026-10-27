import {
  extraPermissionsSchema,
  mergeDenoPermissionFlags,
} from '~/extra-permissions';
import { subprocessSandboxEnv } from './sandbox-env';
import { run } from './subprocess';

/** Validate declarations with the installed runtime without evaluating App code. */
export async function assertDenoPermissionFlags(
  flags: string[],
  cwd: string,
): Promise<void> {
  const extras = extraPermissionsSchema.parse(flags);
  const result = await run(
    'deno',
    [
      'run',
      '--no-config',
      '--no-prompt',
      ...mergeDenoPermissionFlags([], extras),
      '-',
    ],
    { cwd, env: subprocessSandboxEnv(), input: '' },
  );
  if (result.code !== 0) {
    throw new Error(
      `Invalid extraPermissions:\n${result.stderr || result.stdout}`,
    );
  }
}
