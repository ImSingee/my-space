/** Shared validation for Agent-authored Deno dependency configuration. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isAppRegistryConfigName,
  isUnsupportedAppRootConfigName,
} from './app-managed-path';

type SourceKind = 'app' | 'workflow';
type JsonObject = Record<string, unknown>;

export type DenoDependencyValidation = {
  lifecycleScripts: string[];
};

export type DenoDependencySourceFile =
  | 'package.json'
  | 'deno.json'
  | 'deno.lock';
export type DenoDependencySourceReader = (
  file: DenoDependencySourceFile,
) => Promise<string | null>;

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

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value as JsonObject;
}

function isHatchPackage(value: string): boolean {
  return /^(?:npm:|jsr:)?@hatch\//.test(value);
}

function isLocalDependencySpecifier(value: string): boolean {
  const specifier = value.trim();
  return (
    /^(?:file|link|workspace|portal):/i.test(specifier) ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\\\') ||
    /^[a-zA-Z]:[\\/]/.test(specifier)
  );
}

function assertStandaloneAppDependencySource(
  packageJson: JsonObject,
  config: JsonObject,
): void {
  if (packageJson.workspaces !== undefined || config.workspace !== undefined) {
    throw new Error(
      'App sources must be standalone and cannot declare package.json ' +
        'workspaces or deno.json workspace members. Declare registry ' +
        'dependencies directly in package.json.',
    );
  }

  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value === 'string' && isLocalDependencySpecifier(value)) {
        throw new Error(
          `App dependency "${name}" in ${section} uses local specifier ` +
            `"${value}". App sources must deploy as standalone trees; use a ` +
            'registry version instead.',
        );
      }
    }
  }
}

function assertFixedAppConfiguration(
  packageJson: JsonObject,
  config: JsonObject,
): void {
  if (packageJson.type !== 'module') {
    throw new Error(
      'App package.json must declare "type": "module". Hatch Apps use ESM.',
    );
  }

  const unsupportedConfigKey = ['imports', 'scopes', 'importMap'].find((key) =>
    Object.hasOwn(config, key),
  );
  if (unsupportedConfigKey) {
    throw new Error(
      `App deno.json must not declare ${unsupportedConfigKey}. Declare npm ` +
        'dependencies in package.json, use explicit relative imports for App ' +
        'source, and use the platform-owned .hatch/import-map.json.',
    );
  }

  const compilerOptions = config.compilerOptions;
  if (
    !compilerOptions ||
    typeof compilerOptions !== 'object' ||
    Array.isArray(compilerOptions)
  ) {
    throw new Error(
      'App deno.json compilerOptions must be an object with strict=true, ' +
        'jsx="react-jsx", and jsxImportSource="react".',
    );
  }
  const compiler = compilerOptions as JsonObject;
  if (compiler.strict !== true) {
    throw new Error('App deno.json compilerOptions.strict must be true.');
  }
  if (compiler.jsx !== 'react-jsx') {
    throw new Error('App deno.json compilerOptions.jsx must be "react-jsx".');
  }
  if (compiler.jsxImportSource !== 'react') {
    throw new Error(
      'App deno.json compilerOptions.jsxImportSource must be "react".',
    );
  }

  const allowScripts = config.allowScripts;
  if (
    allowScripts !== undefined &&
    (!Array.isArray(allowScripts) || allowScripts.length > 0)
  ) {
    throw new Error(
      'App deno.json allowScripts must be absent or an empty array. Hatch Apps ' +
        'do not support dependencies that require npm lifecycle scripts.',
    );
  }
}

function assertNoManagedHatchSdk(
  packageJson: JsonObject,
  config: JsonObject,
  lock: JsonObject,
): void {
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== 'object') continue;
    const name = Object.keys(dependencies).find(isHatchPackage);
    if (name) {
      throw new Error(
        `${name} is provided by Hatch and must not be declared in ` +
          `${section}. Remove it from package.json and regenerate deno.lock ` +
          'with `deno install`.',
      );
    }
  }

  const configuredImports = [config.imports];
  if (
    config.scopes &&
    typeof config.scopes === 'object' &&
    !Array.isArray(config.scopes)
  ) {
    configuredImports.push(...Object.values(config.scopes));
  }
  for (const imports of configuredImports) {
    if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
      continue;
    }
    const name = Object.keys(imports).find(isHatchPackage);
    if (name) {
      throw new Error(
        `${name} is provided by Hatch and must not be mapped in deno.json. ` +
          'Use the platform-owned .hatch/import-map.json.',
      );
    }
  }

  const specifiers = lock.specifiers;
  const npm = lock.npm;
  const jsr = lock.jsr;
  const workspace =
    lock.workspace &&
    typeof lock.workspace === 'object' &&
    !Array.isArray(lock.workspace)
      ? (lock.workspace as JsonObject)
      : {};
  const workspacePackageJson =
    workspace.packageJson &&
    typeof workspace.packageJson === 'object' &&
    !Array.isArray(workspace.packageJson)
      ? (workspace.packageJson as JsonObject)
      : {};
  const workspaceDependencies = [
    ...(Array.isArray(workspace.dependencies) ? workspace.dependencies : []),
    ...(Array.isArray(workspacePackageJson.dependencies)
      ? workspacePackageJson.dependencies
      : []),
  ].filter((value): value is string => typeof value === 'string');
  const lockedName = [
    ...(specifiers && typeof specifiers === 'object'
      ? Object.keys(specifiers)
      : []),
    ...(npm && typeof npm === 'object' ? Object.keys(npm) : []),
    ...(jsr && typeof jsr === 'object' ? Object.keys(jsr) : []),
    ...workspaceDependencies,
  ].find(isHatchPackage);
  if (lockedName) {
    throw new Error(
      `${lockedName} is a stale platform-managed Hatch SDK entry in deno.lock. ` +
        'Run `deno install` after removing @hatch/* from package.json, then ' +
        'commit the regenerated lockfile.',
    );
  }
}

/**
 * Require the source-controlled package/config/lock contract before invoking
 * Deno. Shared by deploy validation and runner-side worktree preparation.
 */
export async function validateDenoDependencySource(
  sourceDir: string,
  kind: SourceKind,
  sourceReader?: DenoDependencySourceReader,
): Promise<DenoDependencyValidation> {
  // Deno's npm client reads a project-local .npmrc even when invoked with
  // --no-config. An App-controlled registry or auth setting would let a deploy
  // build send privileged network requests or credentials to an arbitrary
  // endpoint, so npm configuration is a platform concern, not App source.
  if (!sourceReader) {
    const rootEntries = await fs.readdir(sourceDir);
    const npmConfigEntry = rootEntries.find(isAppRegistryConfigName);
    if (npmConfigEntry) {
      throw new Error(
        `${kind} sources cannot include ${npmConfigEntry}. npm registry and ` +
          'authentication configuration is managed by the platform.',
      );
    }
    if (kind === 'app') {
      const unsupportedConfig = rootEntries.find(
        isUnsupportedAppRootConfigName,
      );
      if (unsupportedConfig) {
        throw new Error(
          `App sources cannot include ${unsupportedConfig}. Hatch Apps use ` +
            'the canonical root deno.json and do not load alternate TypeScript ' +
            'configuration files.',
        );
      }
    }
  }

  const readSource =
    sourceReader ??
    ((file: DenoDependencySourceFile) =>
      readOptionalFile(path.join(sourceDir, file)));
  const [packageSource, configSource, lockSource] = await Promise.all([
    readSource('package.json'),
    readSource('deno.json'),
    readSource('deno.lock'),
  ]);
  const hasPackage = packageSource !== null;
  const hasConfig = configSource !== null;
  const hasLock = lockSource !== null;

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

  const packageJson = jsonObject(
    readJson(packageSource as string, 'package.json'),
    'package.json',
  );
  const config = jsonObject(
    readJson(configSource as string, 'deno.json'),
    'deno.json',
  );
  const lock = jsonObject(
    readJson(lockSource as string, 'deno.lock'),
    'deno.lock',
  );
  assertNoManagedHatchSdk(packageJson, config, lock);

  if (kind === 'app') {
    assertStandaloneAppDependencySource(packageJson, config);
    assertFixedAppConfiguration(packageJson, config);
    return { lifecycleScripts: [] };
  }

  const allowScripts = config.allowScripts;
  if (allowScripts !== undefined && !Array.isArray(allowScripts)) {
    throw new Error(
      'deno.json allowScripts must be an array of reviewed, exact npm package ' +
        'versions such as "npm:pkg@1.2.3"; booleans and ranges are forbidden.',
    );
  }

  const npmLock =
    lock && typeof lock === 'object' && !Array.isArray(lock)
      ? lock.npm
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
  return { lifecycleScripts: (allowScripts ?? []) as string[] };
}
