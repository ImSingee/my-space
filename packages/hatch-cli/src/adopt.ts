/** Bind an existing Agent checkout only after proving its source identity. */
import { lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, basename, dirname, relative, sep } from 'node:path';
import type { PlatformClient } from './client';
import type { Profile } from './config';
import { CliError } from './error';
import {
  git,
  importBundle,
  saveWorkspace,
  safeTree,
  type Kind,
  type Workspace,
} from './workspace';
import { readWorkspaceManifest } from './preparation';

export async function adopt(
  root: string,
  kind: Kind,
  id: string,
  credential: Profile,
  client: PlatformClient,
  signal: AbortSignal,
): Promise<Workspace> {
  const api = kind === 'app' ? client.apps : client.workflows;
  const detail = await api.get({ id });
  const gitDir = await lstat(join(root, '.git')).catch(() => null);
  if (!gitDir?.isDirectory() || gitDir.isSymbolicLink())
    throw new CliError(
      'invalid_workspace',
      'Agent checkout requires a real .git directory.',
      6,
    );
  if (await lstat(join(root, '.git', 'hatch-cli.json')).catch(() => null))
    throw new CliError(
      'already_adopted',
      'Workspace already has CLI metadata.',
      6,
    );
  const origin = (await git(root, signal, ['remote', 'get-url', 'origin']))
    .stdout;
  if (
    !isAbsolute(origin) ||
    basename(origin) !== `${kind}-${detail.id}.bundle` ||
    basename(dirname(origin)) !== 'bundles' ||
    basename(dirname(dirname(dirname(origin)))) !== 'agents'
  )
    throw new CliError(
      'origin_mismatch',
      'Origin is not the Agent bundle for this immutable resource ID/kind.',
      6,
    );
  const bundleEntry = await lstat(origin).catch(() => null);
  if (
    (bundleEntry && (!bundleEntry.isFile() || bundleEntry.isSymbolicLink())) ||
    (await realpath(dirname(origin))) !== dirname(origin)
  )
    throw new CliError(
      'origin_mismatch',
      'Agent bundle origin traverses a symlink.',
      6,
    );
  const source = await api.source({ id: detail.id });
  if (source.id !== detail.id)
    throw new CliError('resource_changed', 'Resource identity changed.', 6);
  const current = await importBundle(root, source, signal);
  const ownedPath = relative(dirname(dirname(origin)), root);
  if (!ownedPath.startsWith(`work${sep}`) || isAbsolute(ownedPath))
    throw new CliError(
      'origin_mismatch',
      'Checkout must remain inside its Agent session work directory.',
      6,
    );
  if (current && !bundleEntry)
    throw new CliError(
      'origin_mismatch',
      'Committed Agent checkout origin bundle is missing.',
      6,
    );
  const head = await git(root, signal, ['rev-parse', '--verify', 'HEAD'], true);
  if (current) {
    await safeTree(root, signal);
    if (
      head.code !== 0 ||
      (
        await git(
          root,
          signal,
          ['merge-base', '--is-ancestor', current, head.stdout],
          true,
        )
      ).code !== 0
    )
      throw new CliError(
        'source_mismatch',
        'Local history must contain the current platform master. Merge/rebase explicitly before adoption.',
        6,
      );
  } else {
    const status = await client.auth.status({});
    if (
      head.code === 0 ||
      status.credentialType !== 'run' ||
      status.context.sessionId !== basename(dirname(dirname(origin)))
    )
      throw new CliError(
        'ambiguous_checkout',
        'Empty source can only bind an uncommitted checkout owned by the verified current Run session.',
        6,
      );
  }
  let manifest;
  try {
    manifest = await readWorkspaceManifest(root, kind, signal);
  } catch {
    throw new CliError(
      'manifest_mismatch',
      'Cannot validate the existing manifest. Source and origin were preserved.',
      6,
    );
  }
  if (manifest.id !== detail.id)
    throw new CliError(
      'manifest_mismatch',
      'Manifest ID differs from the immutable resource ID.',
      6,
    );
  const observed = await api.get({ id: detail.id });
  if (observed.id !== detail.id || observed.createdAt !== detail.createdAt)
    throw new CliError(
      'RESOURCE_GENERATION_CONFLICT',
      'Resource generation changed during adoption.',
      6,
    );
  const metadata: Workspace = {
    version: 1,
    kind,
    url: credential.url,
    id: detail.id,
    generation: detail.createdAt,
    masterCommit: current,
  };
  await saveWorkspace(root, metadata);
  return metadata;
}
