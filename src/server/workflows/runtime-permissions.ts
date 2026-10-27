import { mergeDenoPermissionFlags } from '~/extra-permissions';
import {
  effectiveNetworkAllowlist,
  type NetworkPolicy,
} from '~/network-policy';

export type WorkflowDenoArgsOptions = {
  bundlePath: string;
  artifactDir: string;
  /** Absent when no policy was declared, which runs unrestricted. */
  network?: NetworkPolicy;
  extraPermissions?: string[];
};

/** Build one permission contract shared by describe mode and real runs. */
export function buildWorkflowDenoArgs({
  bundlePath,
  artifactDir,
  network,
  extraPermissions,
}: WorkflowDenoArgsOptions): string[] {
  const args = ['run'];

  // New policy-aware bundles are self-contained. Disable every ambient module
  // resolution path so permission enforcement cannot be changed by a host-side
  // deno.json, lockfile, npm package, or newly fetched remote module.
  if (network !== undefined) {
    args.push(
      '--no-config',
      '--no-lock',
      '--no-npm',
      '--no-remote',
      '--cached-only',
    );
  }

  const permissionFlags: string[] = [];
  const allowlist = effectiveNetworkAllowlist(network);
  if (allowlist === null) {
    permissionFlags.push('--allow-net');
  } else if (allowlist.length > 0) {
    permissionFlags.push(`--allow-net=${allowlist.join(',')}`);
  }

  permissionFlags.push('--allow-env', `--allow-read=${artifactDir}`);
  args.push(
    ...mergeDenoPermissionFlags(permissionFlags, extraPermissions),
    '--no-prompt',
    bundlePath,
  );
  return args;
}
