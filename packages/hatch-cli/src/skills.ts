/** Offline, transactional installation of the bundled official product Skills. */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError } from './error';
import {
  bundledSkills,
  type SkillBundle,
  type SkillFiles,
} from './skill-bundle';

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = (code: string, message: string): never => {
  throw new CliError(
    code,
    message,
    ['invalid_skill', 'unknown_skill', 'invalid_bundle'].includes(code) ? 2 : 6,
  );
};
const exists = async (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
function validName(name: string) {
  if (!namePattern.test(name) || name.length > 64)
    fail('invalid_skill', `Invalid skill name: ${name}`);
}
function validFile(file: string) {
  if (
    !file
      .split('/')
      .every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) ||
    file.includes('\\')
  )
    fail('invalid_bundle', 'Invalid skill resource path.');
}
function digest(files: SkillFiles) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex');
}
async function directory(path: string) {
  let stat = await exists(path);
  if (!stat) {
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    stat = await lstat(path);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    fail('unsafe_path', `Expected a real directory: ${path}`);
}

/** Never follow links, even for unchanged-file comparison or replacement. */
async function tree(root: string, prefix = ''): Promise<SkillFiles | null> {
  const stat = await exists(root);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('unsafe_path', `Skill path must be a real directory: ${root}`);
  const result: SkillFiles = {};
  for (const name of (await readdir(root)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = join(root, name);
    const entry = await lstat(file);
    if (entry.isSymbolicLink())
      fail(
        'unsafe_path',
        `Symlinks are not allowed in a selected Skill: ${file}`,
      );
    if (entry.isDirectory()) {
      const children = await tree(file, relative);
      if (children && Object.keys(children).length)
        Object.assign(result, children);
      else result[`${relative}/`] = '';
    } else if (entry.isFile())
      result[relative] = (await readFile(file)).toString('base64');
    else
      fail(
        'unsafe_path',
        `Special files are not allowed in a selected Skill: ${file}`,
      );
  }
  return result;
}

function validateBundle(bundle: SkillBundle) {
  const names = new Set<string>();
  for (const skill of bundle.skills) {
    validName(skill.name);
    if (names.has(skill.name))
      fail('invalid_bundle', 'Duplicate official Skill name.');
    names.add(skill.name);
    for (const file of Object.keys(skill.files)) validFile(file);
    const text = Buffer.from(
      skill.files['SKILL.md'] ?? '',
      'base64',
    ).toString();
    if (
      !text.startsWith(`---\nname: ${skill.name}\n`) ||
      !/^description: .+\n---\n/m.test(text)
    )
      fail('invalid_bundle', 'Invalid official Skill frontmatter.');
  }
  for (const skill of bundle.skills)
    for (const dependency of skill.dependencies)
      if (!names.has(dependency))
        fail('invalid_bundle', 'Missing official Skill dependency.');
  if (
    createHash('sha256').update(JSON.stringify(bundle.skills)).digest('hex') !==
    bundle.digest
  )
    fail('invalid_bundle', 'Official Skill bundle checksum mismatch.');
}

type Change = { name: string; before: string | null; after: string };
type Journal = { version: 1; changes: Change[]; committed: boolean };
type Owner = { pid: number; host: string };
async function regularJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail('unsafe_path', 'Transaction metadata must be a regular file.');
  return JSON.parse(await readFile(path, 'utf8'));
}
function parseJournal(value: unknown, allowed: string[]): Journal {
  const journal = value as Journal;
  if (
    journal?.version !== 1 ||
    typeof journal.committed !== 'boolean' ||
    !Array.isArray(journal.changes)
  )
    fail(
      'recovery_required',
      'Invalid install journal; retain the transaction for manual inspection.',
    );
  const names = new Set<string>();
  for (const change of journal.changes) {
    if (!change || typeof change.name !== 'string')
      fail('recovery_required', 'Invalid install journal.');
    validName(change.name);
    if (!allowed.includes(change.name))
      fail(
        'recovery_required',
        'Journal contains an unknown official Skill; use its matching CLI or inspect it manually.',
      );
    if (
      names.has(change.name) ||
      !/^[a-f0-9]{64}$/.test(change.after) ||
      (change.before !== null && !/^[a-f0-9]{64}$/.test(change.before))
    )
      fail('recovery_required', 'Invalid install journal.');
    names.add(change.name);
  }
  return journal;
}
async function saveJournal(lock: string, journal: Journal) {
  await writeFile(join(lock, 'journal.next'), JSON.stringify(journal), {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(join(lock, 'journal.next'), join(lock, 'journal.json'));
}
async function rollback(root: string, lock: string, journal: Journal) {
  for (const base of [root, lock, join(lock, 'backup')]) {
    const stat = await lstat(base);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail('unsafe_path', 'Recovery boundaries must be real directories.');
  }
  // Preflight the entire rollback before deleting anything. Edits after a crash
  // require inspection, never an automatic reset of the user's work.
  for (const change of journal.changes) {
    const current = await tree(join(root, change.name));
    const backup = await tree(join(lock, 'backup', change.name));
    const currentHash = current && digest(current);
    if (backup && digest(backup) !== change.before)
      fail(
        'recovery_required',
        'Backup changed; retain transaction for manual recovery.',
      );
    if (
      currentHash &&
      currentHash !== change.before &&
      currentHash !== change.after
    )
      fail(
        'recovery_required',
        'Skill changed after interruption; retain transaction for manual recovery.',
      );
    if (change.before && !backup && currentHash !== change.before)
      fail(
        'recovery_required',
        'Original Skill is missing; retain transaction for manual recovery.',
      );
  }
  for (const change of [...journal.changes].reverse()) {
    const target = join(root, change.name);
    const backup = join(lock, 'backup', change.name);
    const current = await tree(target);
    if (current && digest(current) === change.after)
      await rm(target, { recursive: true });
    if (await exists(backup)) {
      if (await exists(target))
        fail(
          'recovery_required',
          'Recovery target is occupied; backup retained.',
        );
      await rename(backup, target);
    }
  }
}

async function recover(root: string, lock: string, allowed: string[]) {
  const stat = await lstat(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail('unsafe_path', 'Install transaction must be a real directory.');
  const owner = (await regularJson(join(lock, 'owner.json'))) as Owner;
  if (
    !Number.isSafeInteger(owner?.pid) ||
    owner.pid <= 0 ||
    owner.host !== hostname()
  )
    fail(
      'skills_locked',
      'Cannot prove this install owner is local and stopped; inspect the retained transaction.',
    );
  try {
    process.kill(owner.pid, 0);
    fail(
      'skills_locked',
      'Another installer is running; do not recover a live transaction.',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  // Serialize recovery as well as installation. Never let two stopped-owner
  // observers restore the same backup concurrently.
  const recovery = join(lock, 'recovering');
  try {
    await mkdir(recovery);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail(
        'skills_locked',
        'A recovery is running or was interrupted. Inspect the transaction before removing its recovering marker.',
      );
    throw error;
  }
  try {
    const journalPath = join(lock, 'journal.json');
    if (await exists(journalPath)) {
      const journal = parseJournal(await regularJson(journalPath), allowed);
      if (!journal.committed) await rollback(root, lock, journal);
    }
    await rm(lock, { recursive: true });
  } finally {
    await rm(recovery, { recursive: true, force: true });
  }
}

export async function installSkills(
  bundle: SkillBundle,
  requested: string[],
  options: {
    cwd: string;
    replace?: boolean;
    recover?: boolean;
    signal: AbortSignal;
  },
) {
  validateBundle(bundle);
  const selected = new Set<string>();
  const select = (name: string) => {
    validName(name);
    const skill = bundle.skills.find((entry) => entry.name === name);
    if (!skill)
      return fail(
        'unknown_skill',
        `Unknown official Skill: ${name}. Use hatch skills list.`,
      );
    if (selected.has(name)) return;
    selected.add(name);
    skill.dependencies.forEach(select);
  };
  (requested.length
    ? requested
    : bundle.skills.map((skill) => skill.name)
  ).forEach(select);
  const skills = bundle.skills.filter((skill) => selected.has(skill.name));
  const cwd = await realpath(options.cwd);
  const agents = join(cwd, '.agents');
  const root = join(agents, 'skills');
  await directory(agents);
  await directory(root);
  const lock = join(agents, '.hatch-skills-install');
  let recovered = false;
  if (options.recover && (await exists(lock))) {
    await recover(
      root,
      lock,
      bundle.skills.map((skill) => skill.name),
    );
    recovered = true;
  }
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail(
        'skills_locked',
        'An install transaction exists. If its local owner has stopped, retry with --recover; never delete a live lock.',
      );
    throw error;
  }
  let journal: Journal | undefined;
  let retain = false;
  const check = () => {
    if (options.signal.aborted)
      throw new CliError(
        'cancelled',
        'Skill installation cancelled; previous Skills restored.',
        130,
      );
  };
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname() }),
      { flag: 'wx', mode: 0o600 },
    );
    check();
    await mkdir(join(lock, 'stage'));
    await mkdir(join(lock, 'backup'));
    const results: {
      name: string;
      status: 'installed' | 'unchanged' | 'replaced';
    }[] = [];
    const changes: Change[] = [];
    for (const skill of skills) {
      check();
      const current = await tree(join(root, skill.name));
      const after = digest(skill.files);
      const before = current && digest(current);
      if (before === after) {
        results.push({ name: skill.name, status: 'unchanged' });
        continue;
      }
      if (current && !options.replace)
        fail(
          'skill_conflict',
          `Skill ${skill.name} differs (including extra files). Review it, then use --replace to replace this selected Skill directory.`,
        );
      changes.push({ name: skill.name, before, after });
      results.push({
        name: skill.name,
        status: current ? 'replaced' : 'installed',
      });
      const stage = join(lock, 'stage', skill.name);
      await mkdir(stage);
      for (const [file, encoded] of Object.entries(skill.files)) {
        const parts = file.split('/');
        parts.pop();
        let parent = stage;
        for (const part of parts) {
          parent = join(parent, part);
          await directory(parent);
        }
        await writeFile(join(stage, file), Buffer.from(encoded, 'base64'), {
          flag: 'wx',
          mode: file.startsWith('scripts/') ? 0o755 : 0o644,
        });
      }
      const staged = await tree(stage);
      if (!staged || digest(staged) !== after)
        fail('invalid_bundle', 'Staged Skill validation failed.');
    }
    journal = { version: 1, changes, committed: false };
    await saveJournal(lock, journal);
    for (const change of changes) {
      check();
      // Recheck directory boundaries and content immediately before each swap.
      await directory(agents);
      await directory(root);
      const target = join(root, change.name);
      const current = await tree(target);
      if ((current && digest(current)) !== change.before)
        fail(
          'skill_conflict',
          'Skill changed during installation; retry after inspecting local edits.',
        );
      if (current) await rename(target, join(lock, 'backup', change.name));
      await rename(join(lock, 'stage', change.name), target);
    }
    check();
    await saveJournal(lock, { ...journal, committed: true });
    journal = undefined;
    return {
      ok: true,
      version: bundle.version,
      commit: bundle.commit,
      digest: bundle.digest,
      destination: root,
      recovered,
      skills: results,
    };
  } catch (error) {
    if (journal) {
      try {
        await rollback(root, lock, journal);
      } catch {
        retain = true;
        fail(
          'recovery_required',
          'Installation interrupted and automatic restoration could not finish. Preserve .agents/.hatch-skills-install and inspect it before --recover.',
        );
      }
    }
    if (error instanceof CliError) throw error;
    throw new CliError(
      'skills_io_failed',
      'Skill installation failed during local filesystem writes; previous Skills were restored. Check permissions and available space before retrying.',
      7,
    );
  } finally {
    if (!retain) await rm(lock, { recursive: true, force: true });
  }
}

export async function runSkills(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const operation = args[offset + 1];
  if (!['list', 'install'].includes(operation))
    throw new CliError(
      'invalid_arguments',
      'Use hatch skills list or hatch skills install.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: {
        json: { type: 'boolean' },
        workdir: { type: 'string' },
        ...(operation === 'install'
          ? ({
              skill: { type: 'string', short: 's', multiple: true },
              all: { type: 'boolean' },
              list: { type: 'boolean', short: 'l' },
              replace: { type: 'boolean' },
              recover: { type: 'boolean' },
              yes: { type: 'boolean', short: 'y' },
            } as const)
          : {}),
      },
      allowPositionals: operation === 'install',
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid skills arguments. Use hatch help skills.',
    );
  }
  const values = parsed.values;
  const selected = [
    ...parsed.positionals,
    ...(Array.isArray(values.skill) ? values.skill : []),
  ];
  if (
    values.workdir === '' ||
    (values.all && selected.length) ||
    (values.list && (selected.length || values.replace || values.recover))
  )
    throw new CliError(
      'invalid_arguments',
      'Do not combine --all with selection or --list with install options. Paths must not be empty.',
    );
  let bundle: SkillBundle;
  try {
    bundle = bundledSkills();
  } catch {
    throw new CliError(
      'skills_unavailable',
      'Skills require the built CLI. Run pnpm build:cli, then its dist/main.mjs, or use the installed package.',
      7,
    );
  }
  validateBundle(bundle);
  const listing = operation === 'list' || values.list;
  const result = listing
    ? {
        ok: true,
        version: bundle.version,
        commit: bundle.commit,
        digest: bundle.digest,
        skills: bundle.skills.map(
          ({ name, description, dependencies: required, files }) => ({
            name,
            description,
            dependencies: required,
            files: Object.keys(files),
          }),
        ),
      }
    : await installSkills(bundle, selected, {
        cwd: resolve(String(values.workdir ?? process.cwd())),
        replace: values.replace === true,
        recover: values.recover === true,
        signal,
      });
  process.stdout.write(
    values.json
      ? `${JSON.stringify(result)}\n`
      : listing
        ? `Official Hatch Skills (${bundle.version}, ${bundle.commit ?? 'unknown revision'}):\n${bundle.skills.map((skill) => `${skill.name}\n  ${skill.description}`).join('\n')}\n`
        : `${JSON.stringify(result, null, 2)}\n`,
  );
}
