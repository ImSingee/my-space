import {
  effectiveNetworkAllowlist,
  type NetworkPolicy,
} from '~/network-policy';

export type WorkflowDenoArgsOptions = {
  bundlePath: string;
  artifactDir: string;
  /** Missing only for legacy deployments, which retain unrestricted access. */
  network?: NetworkPolicy;
};

/** Build one permission contract shared by describe mode and real runs. */
export function buildWorkflowDenoArgs({
  bundlePath,
  artifactDir,
  network,
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

  const allowlist = effectiveNetworkAllowlist(network);
  if (allowlist === null) {
    args.push('--allow-net');
  } else if (allowlist.length > 0) {
    args.push(`--allow-net=${allowlist.join(',')}`);
  }

  args.push(
    '--allow-env',
    `--allow-read=${artifactDir}`,
    '--no-prompt',
    bundlePath,
  );
  return args;
}
