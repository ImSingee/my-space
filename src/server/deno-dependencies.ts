/** Shared validation for Agent-authored Deno dependency configuration. */
import { promises as fs } from 'node:fs';
import path from 'node:path';

type SourceKind = 'app' | 'workflow';

const EXACT_NPM_PACKAGE =
  /^npm:(@[^/\s]+\/[^@\s]+|[^@/\s][^@\s]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function skillName(kind: SourceKind): string {
  return kind === 'app' ? 'building-apps' : 'building-workflows';
}

function deployTool(kind: SourceKind): string {
  return kind === 'app' ? 'deploy_app' : 'deploy_workflow';
}

function migrationHelp(kind: SourceKind): string {
  return (
    `Load the "${skillName(kind)}" Skill with read_file, migrate npm ` +
    'dependencies to package.json, run `deno install --package-json ' +
    '--node-modules-dir=auto --lock=deno.lock`, and commit package.json, ' +
    `deno.json, and deno.lock before calling ${deployTool(kind)} again.`
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Require the source-controlled package/config/lock contract before a build is
 * allowed to invoke Deno. This keeps deploy read-only with respect to dependency
 * resolution and prevents a legacy deno.json-only project from silently using a
 * different dependency model.
 */
export async function validateDenoDependencySource(
  sourceDir: string,
  kind: SourceKind,
): Promise<void> {
  const packagePath = path.join(sourceDir, 'package.json');
  const configPath = path.join(sourceDir, 'deno.json');
  const lockPath = path.join(sourceDir, 'deno.lock');
  const [hasPackage, hasConfig, hasLock] = await Promise.all([
    exists(packagePath),
    exists(configPath),
    exists(lockPath),
  ]);

  if (!hasPackage && hasConfig) {
    throw new Error(
      `Legacy deno.json-only ${kind} sources cannot be deployed. ${migrationHelp(
        kind,
      )}`,
    );
  }
  if (!hasPackage) {
    throw new Error(
      `Missing package.json for ${kind} dependencies. ${migrationHelp(kind)}`,
    );
  }
  if (!hasConfig) {
    throw new Error(
      `Missing deno.json for ${kind} dependency policy. ${migrationHelp(kind)}`,
    );
  }
  if (!hasLock) {
    throw new Error(
      `Missing source-controlled deno.lock for ${kind}. ${migrationHelp(kind)}`,
    );
  }

  await readJson(packagePath, 'package.json');
  const config = await readJson(configPath, 'deno.json');
  const lock = await readJson(lockPath, 'deno.lock');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('deno.json must contain a JSON object.');
  }

  const allowScripts = (config as Record<string, unknown>).allowScripts;
  if (allowScripts !== undefined && !Array.isArray(allowScripts)) {
    throw new Error(
      'deno.json allowScripts must be an array of reviewed, exact npm package ' +
        'versions such as "npm:pkg@1.2.3"; booleans and ranges are forbidden.',
    );
  }

  const npmLock =
    lock && typeof lock === 'object' && !Array.isArray(lock)
      ? (lock as { npm?: unknown }).npm
      : undefined;
  const lockedPackages =
    npmLock && typeof npmLock === 'object' && !Array.isArray(npmLock)
      ? new Set(Object.keys(npmLock))
      : new Set<string>();

  for (const value of allowScripts ?? []) {
    if (typeof value !== 'string') {
      throw new Error('Every deno.json allowScripts entry must be a string.');
    }
    const match = EXACT_NPM_PACKAGE.exec(value);
    if (!match) {
      throw new Error(
        `Unsafe allowScripts entry "${value}". Use an exact reviewed version ` +
          'such as "npm:pkg@1.2.3"; booleans, tags, wildcards, and ranges are ' +
          'forbidden.',
      );
    }
    const locked = `${match[1]}@${match[2]}`;
    if (
      ![...lockedPackages].some(
        (candidate) =>
          candidate === locked || candidate.startsWith(`${locked}_`),
      )
    ) {
      throw new Error(
        `allowScripts entry "${value}" is not present at that exact version ` +
          'in deno.lock. Run deno install locally, review the resolved package, ' +
          'and commit the updated lock.',
      );
    }
  }
}
