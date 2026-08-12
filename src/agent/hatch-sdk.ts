/** Platform-owned SDK materialization for Hatch Apps. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeMaterializer } from './worktree-materializer';
import { REPO_ROOT } from './paths';
import { setAgentOwned } from './shell-sandbox';

const HATCH_DATA_SOURCE_DIR = path.join(REPO_ROOT, 'packages', 'hatch-data');

export const HATCH_SDK_IMPORT_MAP = 'node_modules/@hatch/import-map.json';

export const HATCH_SDK_IMPORTS = {
  '@hatch/data': './data/dist/data.js',
  '@hatch/data/react': './data/dist/data-react.js',
} as const;

type JsonObject = Record<string, unknown>;
type ImportMapEntries = Record<string, string>;
type ImportMapScopes = Record<string, ImportMapEntries>;

type AppImportMap = {
  baseDir: string;
  imports: ImportMapEntries;
  scopes: ImportMapScopes;
  sourcePath?: string;
};

type GeneratedImportMap = {
  imports: ImportMapEntries;
  scopes?: ImportMapScopes;
};

export function appHatchDataPackageDir(root: string): string {
  return path.join(root, 'node_modules', '@hatch', 'data');
}

export function appHatchImportMapPath(root: string): string {
  return path.join(root, ...HATCH_SDK_IMPORT_MAP.split('/'));
}

function managedPathError(target: string, reason: string): Error {
  return new Error(
    `Cannot materialize the platform-owned @hatch/data SDK: ${path.basename(
      target,
    )} ${reason}.`,
  );
}

function configError(label: string, reason: string): Error {
  return new Error(
    `Cannot generate the Hatch SDK import map: ${label} ${reason}.`,
  );
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function readAppFile(
  root: string,
  target: string,
  label: string,
  optional = false,
): Promise<string | null> {
  if (!isInsideRoot(root, target)) {
    throw configError(label, 'must stay inside the App source root');
  }

  const relative = path.relative(root, target);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = root;
  try {
    const rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink()) {
      throw configError('App source root', 'must not be a symbolic link');
    }
    for (const segment of segments) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) {
        throw configError(label, 'must not contain symbolic links');
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (optional) return null;
      throw configError(label, 'does not exist');
    }
    throw error;
  }

  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw configError(label, 'must not be a symbolic link');
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw configError(label, 'must be a regular file');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function jsonObject(raw: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw configError(
      label,
      `is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(label, 'must contain a JSON object');
  }
  return value as JsonObject;
}

function importMapEntries(value: unknown, label: string): ImportMapEntries {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(label, 'must contain an object of string mappings');
  }

  const entries: Array<[string, string]> = [];
  for (const [specifier, target] of Object.entries(value)) {
    if (typeof target !== 'string') {
      throw configError(`${label}.${specifier}`, 'must be a string');
    }
    entries.push([specifier, target]);
  }
  return Object.fromEntries(entries);
}

function importMapScopes(value: unknown, label: string): ImportMapScopes {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(label, 'must contain an object of scoped mappings');
  }

  const scopes: Array<[string, ImportMapEntries]> = [];
  for (const [scope, mappings] of Object.entries(value)) {
    scopes.push([scope, importMapEntries(mappings, `${label}.${scope}`)]);
  }
  return Object.fromEntries(scopes);
}

function assertNoAppManagedHatchImports(
  entries: ImportMapEntries,
  label: string,
): void {
  const specifier = Object.keys(entries).find((value) =>
    /^(?:npm:|jsr:)?@hatch(?:\/|$)/.test(value),
  );
  if (specifier) {
    throw configError(
      label,
      `must not map platform-owned specifier "${specifier}"`,
    );
  }
}

function parseAppImportMap(
  value: JsonObject,
  label: string,
  baseDir: string,
): AppImportMap {
  const imports = importMapEntries(value.imports, `${label}.imports`);
  const scopes = importMapScopes(value.scopes, `${label}.scopes`);
  assertNoAppManagedHatchImports(imports, `${label}.imports`);
  for (const [scope, mappings] of Object.entries(scopes)) {
    assertNoAppManagedHatchImports(mappings, `${label}.scopes.${scope}`);
  }
  return { baseDir, imports, scopes };
}

function expandDenoPackageImports(entries: ImportMapEntries): ImportMapEntries {
  const expanded = { ...entries };
  for (const [specifier, target] of Object.entries(entries)) {
    const prefix = `${specifier}/`;
    if (specifier.endsWith('/') || Object.hasOwn(entries, prefix)) continue;

    const suffixIndex = target.search(/[?#]/);
    const pathname = suffixIndex === -1 ? target : target.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : target.slice(suffixIndex);
    const match = /^(jsr|npm):\/?(.+)$/.exec(pathname);
    if (!match) continue;
    const packagePath = match[2].endsWith('/') ? match[2] : `${match[2]}/`;
    expanded[prefix] = `${match[1]}:/${packagePath}${suffix}`;
  }
  return expanded;
}

function applyDenoConfigImportSemantics(map: AppImportMap): AppImportMap {
  return {
    ...map,
    imports: expandDenoPackageImports(map.imports),
    scopes: Object.fromEntries(
      Object.entries(map.scopes).map(([scope, entries]) => [
        scope,
        expandDenoPackageImports(entries),
      ]),
    ),
  };
}

async function loadAppImportMap(root: string): Promise<AppImportMap> {
  const configPath = path.join(root, 'deno.json');
  const rawConfig = await readAppFile(root, configPath, 'deno.json', true);
  if (rawConfig === null) return { baseDir: root, imports: {}, scopes: {} };

  const config = jsonObject(rawConfig, 'deno.json');
  if (Object.hasOwn(config, 'imports') || Object.hasOwn(config, 'scopes')) {
    return applyDenoConfigImportSemantics(
      parseAppImportMap(config, 'deno.json', root),
    );
  }

  if (config.importMap === undefined) {
    return { baseDir: root, imports: {}, scopes: {} };
  }
  if (typeof config.importMap !== 'string' || config.importMap.length === 0) {
    throw configError('deno.json.importMap', 'must be a local relative path');
  }
  if (
    path.isAbsolute(config.importMap) ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(config.importMap) ||
    config.importMap.startsWith('//')
  ) {
    throw configError(
      'deno.json.importMap',
      'must be a local relative path that can be resolved during builds',
    );
  }

  const importMapPath = path.resolve(root, config.importMap);
  const rawImportMap = await readAppFile(
    root,
    importMapPath,
    'deno.json.importMap',
  );
  return {
    ...parseAppImportMap(
      jsonObject(rawImportMap as string, 'deno.json.importMap'),
      'deno.json.importMap',
      path.dirname(importMapPath),
    ),
    sourcePath: importMapPath,
  };
}

function rebaseRelativeSpecifier(
  specifier: string,
  fromDir: string,
  toDir: string,
): string {
  const suffixIndex = specifier.search(/[?#]/);
  const pathname =
    suffixIndex === -1 ? specifier : specifier.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : specifier.slice(suffixIndex);
  if (
    pathname !== '.' &&
    pathname !== '..' &&
    !pathname.startsWith('./') &&
    !pathname.startsWith('../')
  ) {
    return specifier;
  }

  const trailingSlash = pathname.endsWith('/');
  const absolute = path.resolve(fromDir, pathname);
  let rebased = path.relative(toDir, absolute).split(path.sep).join('/');
  if (rebased === '') rebased = '.';
  if (!rebased.startsWith('.')) rebased = `./${rebased}`;
  if (trailingSlash && !rebased.endsWith('/')) rebased += '/';
  return `${rebased}${suffix}`;
}

function rebaseImportMapEntries(
  entries: ImportMapEntries,
  fromDir: string,
  toDir: string,
): ImportMapEntries {
  return Object.fromEntries(
    Object.entries(entries).map(([specifier, target]) => [
      rebaseRelativeSpecifier(specifier, fromDir, toDir),
      rebaseRelativeSpecifier(target, fromDir, toDir),
    ]),
  );
}

async function generatedImportMap(
  root: string,
  importMapPath: string,
): Promise<GeneratedImportMap> {
  const app = await loadAppImportMap(root);
  const targetDir = path.dirname(importMapPath);
  const imports = {
    ...rebaseImportMapEntries(app.imports, app.baseDir, targetDir),
    ...HATCH_SDK_IMPORTS,
  };
  const scopes = Object.fromEntries(
    Object.entries(app.scopes).map(([scope, entries]) => [
      rebaseRelativeSpecifier(scope, app.baseDir, targetDir),
      rebaseImportMapEntries(entries, app.baseDir, targetDir),
    ]),
  );
  return Object.keys(scopes).length > 0 ? { imports, scopes } : { imports };
}

/** Local external map that deno.json requires the deployment to retain. */
export async function appExternalImportMapPath(
  root: string,
): Promise<string | null> {
  return (await loadAppImportMap(root)).sourcePath ?? null;
}

async function ensureManagedDirectory(target: string): Promise<void> {
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) {
      throw managedPathError(target, 'is a symbolic link');
    }
    if (!entry.isDirectory()) {
      throw managedPathError(target, 'is not a directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(target);
  }
}

async function assertReplaceableTarget(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw managedPathError(target, 'is a symbolic link');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function assertSdkBuildExists(): Promise<void> {
  try {
    await access(path.join(HATCH_DATA_SOURCE_DIR, 'dist', 'data.js'));
    await access(path.join(HATCH_DATA_SOURCE_DIR, 'dist', 'data.d.ts'));
    await access(path.join(HATCH_DATA_SOURCE_DIR, 'dist', 'data-react.js'));
    await access(path.join(HATCH_DATA_SOURCE_DIR, 'dist', 'data-react.d.ts'));
  } catch {
    throw new Error(
      'Hatch SDK build output is missing. Run `pnpm hatch-sdk:build`.',
    );
  }
}

/**
 * Refresh the generated SDK package without trusting anything already present
 * in the App checkout. The package is deliberately outside the App dependency
 * graph: Deno resolves it through the platform-owned import map generated next
 * to the package.
 */
export async function materializeAppHatchSdk(root: string): Promise<void> {
  await assertSdkBuildExists();
  const nodeModules = path.join(root, 'node_modules');
  const scope = path.join(nodeModules, '@hatch');
  const destination = appHatchDataPackageDir(root);
  const importMap = appHatchImportMapPath(root);
  const mergedImportMap = await generatedImportMap(root, importMap);
  await ensureManagedDirectory(nodeModules);
  await ensureManagedDirectory(scope);
  await assertReplaceableTarget(destination);
  await assertReplaceableTarget(importMap);

  const id = randomUUID();
  const temporary = path.join(scope, `.data-${id}`);
  const temporaryImportMap = path.join(scope, `.import-map-${id}.json`);
  try {
    await mkdir(temporary);
    await Promise.all([
      cp(
        path.join(HATCH_DATA_SOURCE_DIR, 'package.json'),
        path.join(temporary, 'package.json'),
      ),
      cp(
        path.join(HATCH_DATA_SOURCE_DIR, 'dist'),
        path.join(temporary, 'dist'),
        { recursive: true },
      ),
      writeFile(
        temporaryImportMap,
        `${JSON.stringify(mergedImportMap, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      ),
    ]);
    setAgentOwned([temporary, temporaryImportMap]);
    // Recheck the untrusted parent and final entry immediately before replacing
    // the managed package. Checkout/build operations serialize materialization.
    await ensureManagedDirectory(nodeModules);
    await ensureManagedDirectory(scope);
    await assertReplaceableTarget(destination);
    await assertReplaceableTarget(importMap);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    await rm(importMap, { recursive: true, force: true });
    await rename(temporaryImportMap, importMap);
  } finally {
    await Promise.all([
      rm(temporary, { recursive: true, force: true }),
      rm(temporaryImportMap, { force: true }),
    ]);
  }
}

export const appHatchSdkMaterializer = {
  gitExcludePatterns: ['/node_modules/@hatch/'],
  materialize: materializeAppHatchSdk,
} satisfies WorktreeMaterializer;
