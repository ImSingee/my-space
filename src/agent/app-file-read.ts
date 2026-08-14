/** Read Agent-authored files without giving path races Runner privileges. */
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS_DIR } from './paths';
import { resolveAgentOwnershipSession, sandboxSpawn } from './shell-sandbox';

export type AgentFileReadResult =
  | { content: string }
  | { error: 'missing' | 'not_file' | 'symlink' };

export type AgentSourcePreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'generated_missing'
        | 'generated_invalid'
        | 'registry_config'
        | 'unsupported_config'
        | 'reserved_path'
        | 'source_symlink';
      path: string;
    };

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function isAgentAuthoredRoot(root: string): boolean {
  return isInside(AGENTS_DIR, path.resolve(root));
}

/** Scan the whole authored tree and generated roots with Agent authority. */
export async function preflightAgentAuthoredSource(
  root: string,
  generatedRoots: readonly string[],
  requiredGeneratedRoots: readonly string[],
  authoredExclusions: readonly string[],
): Promise<AgentSourcePreflightResult> {
  const canonicalRoot = await realpath(root);
  const payload = {
    generatedRoots,
    requiredGeneratedRoots,
    authoredExclusions,
  };
  const helper = String.raw`
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
const [root, expectedRoot, encodedPayload] = process.argv.slice(1);
const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
const lists = [payload.generatedRoots, payload.requiredGeneratedRoots, payload.authoredExclusions];
if (lists.some((list) => !Array.isArray(list) || list.some((value) =>
  typeof value !== 'string' || !value || value === '.' || value === '..' ||
  value.includes('/') || value.includes('\\')))) {
  throw new Error('Invalid source preflight manifest.');
}
if (await realpath('.') !== expectedRoot || await realpath(root) !== expectedRoot) {
  throw new Error('Agent worktree root changed during source preflight.');
}
const required = new Set(payload.requiredGeneratedRoots);
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.name.toLowerCase() === '.npmrc') {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: 'registry_config',
      path: entry.name,
    }));
    process.exit(0);
  }
  if (['deno.jsonc', 'tsconfig.json', 'jsconfig.json'].includes(entry.name.toLowerCase())) {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: 'unsupported_config',
      path: entry.name,
    }));
    process.exit(0);
  }
  if (entry.name.toLowerCase() === '.hatch' && entry.name !== '.hatch') {
    process.stdout.write(JSON.stringify({
      ok: false,
      reason: 'reserved_path',
      path: entry.name,
    }));
    process.exit(0);
  }
}
for (const name of payload.generatedRoots) {
  let entry;
  try { entry = await lstat(path.join(root, name)); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      if (required.has(name)) {
        process.stdout.write(JSON.stringify({ ok: false, reason: 'generated_missing', path: name }));
        process.exit(0);
      }
      continue;
    }
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'generated_invalid', path: name }));
    process.exit(0);
  }
}
const excluded = new Set(payload.authoredExclusions);
async function scan(relative = '') {
  const current = relative ? path.join(root, ...relative.split('/')) : root;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = relative ? relative + '/' + entry.name : entry.name;
    if (!relative && entry.name.toLowerCase() === '.npmrc') {
      return { reason: 'registry_config', path: child };
    }
    if (!relative && ['deno.jsonc', 'tsconfig.json', 'jsconfig.json'].includes(entry.name.toLowerCase())) {
      return { reason: 'unsupported_config', path: child };
    }
    if (entry.name.toLowerCase() === '.hatch') {
      if (!relative && entry.name === '.hatch') continue;
      return { reason: 'reserved_path', path: child };
    }
    if (!relative && excluded.has(entry.name)) continue;
    const stat = await lstat(path.join(root, ...child.split('/')));
    if (stat.isSymbolicLink()) return { reason: 'source_symlink', path: child };
    if (stat.isDirectory()) {
      const found = await scan(child);
      if (found) return found;
    }
  }
  return null;
}
const finding = await scan();
process.stdout.write(JSON.stringify(finding ? { ok: false, ...finding } : { ok: true }));
`;
  const wrapped = sandboxSpawn(
    [
      process.execPath,
      '--input-type=module',
      '--eval',
      helper,
      canonicalRoot,
      canonicalRoot,
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
    ],
    resolveAgentOwnershipSession([canonicalRoot]),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: canonicalRoot,
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `Sandboxed source preflight exited with status ${code ?? 'unknown'}.`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout) as AgentSourcePreflightResult);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * The fixed helper receives only validated path segments and runs through the
 * same UID/seatbelt boundary as Agent commands. An intermediate-path swap can
 * therefore never turn this read into access the Agent did not already have.
 */
export async function readAgentAuthoredFile(
  root: string,
  segments: readonly string[],
): Promise<AgentFileReadResult> {
  if (
    segments.length === 0 ||
    segments.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes('/') ||
        part.includes('\\'),
    )
  ) {
    throw new Error('Invalid Agent-authored file path.');
  }
  const canonicalRoot = await realpath(root);
  const helper = String.raw`
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const [root, expectedRoot, encodedSegments] = process.argv.slice(1);
const segments = JSON.parse(Buffer.from(encodedSegments, 'base64url').toString());
if (!Array.isArray(segments) || segments.length === 0 || segments.some((part) =>
  typeof part !== 'string' || !part || part === '.' || part === '..' ||
  part.includes('/') || part.includes('\\'))) {
  throw new Error('Invalid Agent-authored file path.');
}
if (await realpath('.') !== expectedRoot || await realpath(root) !== expectedRoot) {
  throw new Error('Agent worktree root changed while reading a file.');
}
let current = root;
for (const segment of segments) {
  current = path.join(current, segment);
  let entry;
  try {
    entry = await lstat(current);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      process.stdout.write(JSON.stringify({ error: 'missing' }));
      process.exit(0);
    }
    throw error;
  }
  if (entry.isSymbolicLink()) {
    process.stdout.write(JSON.stringify({ error: 'symlink' }));
    process.exit(0);
  }
}
let handle;
try {
  handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
} catch (error) {
  if (error?.code === 'ELOOP') {
    process.stdout.write(JSON.stringify({ error: 'symlink' }));
    process.exit(0);
  }
  throw error;
}
try {
  if (!(await handle.stat()).isFile()) {
    process.stdout.write(JSON.stringify({ error: 'not_file' }));
  } else {
    const contents = await handle.readFile();
    process.stdout.write(JSON.stringify({ content: contents.toString('base64') }));
  }
} finally {
  await handle.close();
}
`;
  const wrapped = sandboxSpawn(
    [
      process.execPath,
      '--input-type=module',
      '--eval',
      helper,
      canonicalRoot,
      canonicalRoot,
      Buffer.from(JSON.stringify(segments)).toString('base64url'),
    ],
    resolveAgentOwnershipSession([canonicalRoot]),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: canonicalRoot,
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `Sandboxed Agent file read exited with status ${code ?? 'unknown'}.`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as
          | { content: string }
          | { error: 'missing' | 'not_file' | 'symlink' };
        resolve(
          'content' in parsed
            ? {
                content: Buffer.from(parsed.content, 'base64').toString('utf8'),
              }
            : parsed,
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}
