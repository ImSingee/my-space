import { parseArgs } from 'node:util';
import { mkdtemp, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configPath, resolveCredential } from './config';
import { platformClient } from './client';
import { CliError } from './error';
import {
  assertAbsent,
  canonicalTarget,
  clean,
  git,
  importBundle,
  installSdk,
  safeTree,
  saveWorkspace,
  writeFiles,
  sourceBundle,
  withWorkspaceLock,
  workspace,
} from './workspace';
import type { Kind, Workspace } from './workspace';
import { readInput } from './input';
import { isValidAppSlug } from '../../hatch-manifest/src/app-schema.js';
import { isValidWorkflowSlug } from '../../hatch-manifest/src/workflow-schema.js';

export async function runLifecycle(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const kind = args[offset] as Kind;
  const operation = args[offset + 1];
  if (!operation)
    throw new CliError(
      'invalid_arguments',
      'Supply a lifecycle subcommand. Use hatch help.',
    );
  const available = [
    'list',
    'get',
    'create',
    'clone',
    'update',
    'deploy',
    'rollback',
  ];
  if (!available.includes(operation))
    throw new CliError(
      'unsupported_command',
      'This command is not supported. Use hatch help for implemented commands.',
      8,
    );
  const common = {
    json: { type: 'boolean' },
    profile: { type: 'string' },
    config: { type: 'string' },
    timeout: { type: 'string' },
    workdir: { type: 'string' },
  } as const;
  const extra: Record<string, { type: 'string' | 'boolean' }> =
    operation === 'create'
      ? { file: { type: 'string' }, directory: { type: 'string' } }
      : operation === 'clone' || operation === 'update'
        ? { directory: { type: 'string' } }
        : operation === 'deploy'
          ? {
              directory: { type: 'string' },
              message: { type: 'string' },
              'allow-destructive-data-migration': { type: 'boolean' },
              'data-migration-approval-token': { type: 'string' },
              reconcile: { type: 'boolean' },
              'retry-after-confirming': { type: 'string' },
            }
          : operation === 'rollback'
            ? { version: { type: 'string' } }
            : {};
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: { ...common, ...extra },
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid arguments. Use hatch help.',
    );
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positional = parsed.positionals;
  const requiresId = ['get', 'clone', 'rollback'].includes(operation);
  if (
    positional.length !== (requiresId ? 1 : 0) ||
    (requiresId && (!positional[0] || positional[0].startsWith('-')))
  )
    throw new CliError(
      'invalid_arguments',
      'Supply exactly one ID/slug for get/clone/rollback, and no positional arguments for other commands.',
    );
  const seconds =
    values.timeout === undefined
      ? operation === 'deploy'
        ? 600
        : 30
      : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    values.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(values.profile))
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if (
    [values.config, values.workdir, values.directory].some(
      (value) => value === '',
    )
  )
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const timeout = Math.ceil(seconds * 1000);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config as string | undefined),
    values.profile as string | undefined,
  );
  const client = platformClient(credential, timeout, signal);
  const api = kind === 'app' ? client.apps : client.workflows;
  const workdir = resolve(String(values.workdir ?? '.'));
  const directory = resolve(workdir, String(values.directory ?? '.'));
  const output = (value: unknown) =>
    process.stdout.write(
      `${JSON.stringify(value, null, values.json ? undefined : 2)}\n`,
    );
  if (operation === 'list') {
    output(await api.list({}));
    return;
  }
  if (operation === 'get') {
    output(await api.get({ id: positional[0] }));
    return;
  }
  if (operation === 'rollback') {
    const version = Number(values.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new CliError(
        'invalid_arguments',
        'Supply --version <positive-integer> for rollback.',
      );
    output(
      await api.rollback({
        params: { id: (await api.get({ id: positional[0] })).id },
        body: { version },
      }),
    );
    return;
  }
  if (operation === 'create' || operation === 'clone') {
    const input =
      operation === 'create'
        ? await readInput(String(values.file ?? ''), signal)
        : null;
    const isValidSlug = kind === 'app' ? isValidAppSlug : isValidWorkflowSlug;
    if (input && (typeof input.slug !== 'string' || !isValidSlug(input.slug)))
      throw new CliError(
        'invalid_input',
        'Create input requires a slug of at most 64 characters using lowercase ' +
          'letters, digits, and hyphens, starting with a letter or digit.',
      );
    const detail =
      operation === 'clone' ? await api.get({ id: positional[0] }) : null;
    const target = await canonicalTarget(
      resolve(workdir, String(values.directory ?? input?.slug ?? detail?.slug)),
    );
    await withWorkspaceLock(target, async (root) => {
      await assertAbsent(root);
      const stage = await mkdtemp(join(dirname(root), '.hatch-cli-stage-'));
      let recovery = stage;
      try {
        await git(stage, signal, ['init', '-b', 'master']);
        await writeFile(
          join(stage, '.git', 'hatch-recovery.json'),
          JSON.stringify({
            command: operation,
            url: credential.url,
            requested: input ?? positional[0],
            startedAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
        let metadata: Workspace;
        if (operation === 'create') {
          // Validate using the same public input contract before making a mutation.
          const created =
            kind === 'app'
              ? await client.apps.create(
                  input as Parameters<typeof client.apps.create>[0],
                )
              : await client.workflows.create(
                  input as Parameters<typeof client.workflows.create>[0],
                );
          await writeFile(
            join(stage, '.git', 'hatch-create.json'),
            JSON.stringify(created),
            { mode: 0o600 },
          );
          await writeFiles(stage, created.files);
          await git(stage, signal, ['add', '.']);
          await git(stage, signal, [
            '-c',
            'user.name=Hatch CLI',
            '-c',
            'user.email=cli@hatch.local',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '-m',
            'Initialize scaffold',
          ]);
          const row = await api.get({ id: created.id });
          metadata = {
            version: 1,
            kind,
            url: credential.url,
            id: created.id,
            generation: row.createdAt,
            masterCommit: null,
          };
        } else {
          const source = await api.source({ id: detail!.id });
          if (source.id !== detail!.id)
            throw new CliError(
              'resource_changed',
              'Resource identity changed.',
              6,
            );
          const commit = await importBundle(stage, source, signal);
          await git(stage, signal, ['checkout', '-B', 'master', commit]);
          metadata = {
            version: 1,
            kind,
            url: credential.url,
            id: detail!.id,
            generation: detail!.createdAt,
            masterCommit: commit,
          };
        }
        await saveWorkspace(stage, metadata);
        await assertAbsent(root);
        await rename(stage, root);
        recovery = root;
        await installSdk(root, kind, credential, timeout, signal);
        output({
          id: metadata.id,
          directory: root,
          generation: metadata.generation,
          masterCommit: metadata.masterCommit,
          dependenciesInstalled: true,
        });
      } catch (error) {
        // Preserve the actual template/checkout and local journal for recovery.
        const cause =
          error instanceof CliError
            ? error
            : new CliError(
                'workspace_preparation_failed',
                'Creation/clone/preparation failed. Inspect remote state; do not blindly create again.',
                7,
              );
        throw new CliError(
          cause.code,
          `${cause.message} Recovery workspace: ${recovery}`,
          cause.exitCode,
        );
      }
    });
    return;
  }
  await withWorkspaceLock(directory, async (root) => {
    const metadata = await workspace(root, kind, credential);
    const detail = await api.get({ id: metadata.id });
    if (detail.id !== metadata.id || detail.createdAt !== metadata.generation)
      throw new CliError(
        'RESOURCE_GENERATION_CONFLICT',
        'Resource was deleted/recreated. Clone into a new directory; local work was retained.',
        6,
      );
    await clean(root, signal);
    await safeTree(root, signal);
    const head = (await git(root, signal, ['rev-parse', 'HEAD'])).stdout;
    if (operation === 'update') {
      const source = await api.source({ id: metadata.id });
      if (!source.masterCommit && metadata.masterCommit === null) {
        await installSdk(root, kind, credential, timeout, signal);
        output({
          id: metadata.id,
          directory: root,
          masterCommit: null,
          state: 'draft-prepared',
        });
        return;
      }
      const remote = await importBundle(root, source, signal);
      if (head !== remote) {
        if (
          (
            await git(
              root,
              signal,
              ['merge-base', '--is-ancestor', head, remote],
              true,
            )
          ).code !== 0
        )
          throw new CliError(
            'non_fast_forward',
            'Local history is ahead or diverged. Remote history was fetched into FETCH_HEAD; explicitly merge/rebase your work before retrying. No source was reset.',
            6,
          );
        await git(root, signal, ['merge', '--ff-only', remote]);
      }
      metadata.masterCommit = remote;
      await saveWorkspace(root, metadata);
      await installSdk(root, kind, credential, timeout, signal);
      output({
        id: metadata.id,
        directory: root,
        masterCommit: remote,
        state: head === remote ? 'current' : 'fast-forwarded',
      });
      return;
    }
    if (metadata.pending && values['retry-after-confirming']) {
      if (
        values.reconcile ||
        values['retry-after-confirming'] !== metadata.pending.commit
      )
        throw new CliError(
          'invalid_retry_confirmation',
          'Confirm the exact pending commit after inspecting platform release history and ensuring the earlier request finished.',
        );
      await writeFile(
        join(root, '.git', 'hatch-deploy-confirmations.jsonl'),
        JSON.stringify({
          ...metadata.pending,
          confirmedAt: new Date().toISOString(),
        }) + '\n',
        { flag: 'a', mode: 0o600 },
      );
      delete metadata.pending;
      await saveWorkspace(root, metadata);
    }
    if (metadata.pending) {
      const source = await api.source({ id: metadata.id });
      if (values.reconcile) {
        const observed = source.masterCommit;
        output({
          id: metadata.id,
          state:
            observed === metadata.pending.commit
              ? 'source-matches-pending'
              : 'outcome-unresolved',
          pending: metadata.pending,
          masterCommit: observed,
          note: 'Source equality does not prove a deployment version or that an earlier request has finished. Inspect platform release history before another deploy.',
        });
        return;
      }
      throw new CliError(
        'deployment_outcome_unknown',
        'A previous deployment has an unresolved outcome. Use --reconcile, inspect platform release history, then use --retry-after-confirming <pending-commit> only after confirming that request finished. No automatic retry was made.',
        6,
      );
    }
    if (values.reconcile)
      throw new CliError(
        'no_pending_deployment',
        'No pending deployment to reconcile.',
      );
    const approved = values['allow-destructive-data-migration'] === true;
    const approval = values['data-migration-approval-token'];
    if (
      approved !== (typeof approval === 'string' && !!approval) ||
      (kind === 'workflow' && approved)
    )
      throw new CliError(
        'invalid_approval',
        'App destructive approval requires both --allow-destructive-data-migration and the exact --data-migration-approval-token.',
      );
    const upload = await sourceBundle(root, signal);
    metadata.pending = {
      command: 'deploy',
      commit: head,
      startedAt: new Date().toISOString(),
    };
    await saveWorkspace(root, metadata);
    try {
      const result = await api.deploy({
        params: { id: metadata.id },
        body: {
          message: String(values.message ?? 'Deploy from Hatch CLI'),
          generation: metadata.generation,
          bundleBase64: upload,
          ...(approved
            ? {
                allowDestructiveDataMigration: true,
                dataMigrationApprovalToken: String(approval),
              }
            : {}),
        },
      });
      metadata.masterCommit = head;
      metadata.lastDeployment = result;
      delete metadata.pending;
      await saveWorkspace(root, metadata);
      output({ ...result, id: metadata.id, sourceCommit: head });
    } catch (error) {
      // A definite 4xx response is a rejected deployment, and is safe to fix/retry.
      if (isRejected(error)) {
        delete metadata.pending;
        await saveWorkspace(root, metadata);
      }
      throw error;
    }
  });
}
import { ORPCError } from '@orpc/client';
function isRejected(error: unknown) {
  return (
    (error instanceof ORPCError && error.status >= 400 && error.status < 500) ||
    (error instanceof CliError &&
      !!error.httpStatus &&
      error.httpStatus >= 400 &&
      error.httpStatus < 500)
  );
}
