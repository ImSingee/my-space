/** Adapt the authoritative product skills to the CLI shipped in this build. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadSkills } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  LATEST_APP_COMPATIBILITY_VERSION,
  MIN_SUPPORTED_APP_COMPATIBILITY_VERSION,
} from '../src/app-compatibility';
import {
  LATEST_WORKFLOW_COMPATIBILITY_VERSION,
  MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION,
} from '../src/workflow-compatibility';
import { commandDefinitions } from '../packages/hatch-cli/src/commands';
import type {
  OfficialSkill,
  SkillBundle,
} from '../packages/hatch-cli/src/skill-bundle';

const dependencies: Record<string, string[]> = {
  'building-apps': ['app-compatibility'],
  'building-workflows': ['workflow-compatibility', 'building-apps'],
  'importing-apps': ['building-apps'],
  'importing-workflows': ['building-workflows'],
  'app-compatibility': ['building-apps'],
  'workflow-compatibility': ['building-workflows'],
};

function section(text: string, heading: string, replacement: string) {
  const start = text.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`Missing product skill section: ${heading}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(0, start) + replacement + (end < 0 ? '' : text.slice(end));
}

const tools: Record<string, string> = {
  list_apps: 'hatch app list',
  get_app: 'hatch app get <id>',
  create_app: 'hatch app create --file <json-path> --directory <path>',
  deploy_app: 'hatch app deploy --directory <path> --message <text>',
  rollback_app: 'hatch app rollback <id> --version <number>',
  list_workflows: 'hatch workflow list',
  get_workflow: 'hatch workflow get <id>',
  create_workflow:
    'hatch workflow create --file <json-path> --directory <path>',
  deploy_workflow: 'hatch workflow deploy --directory <path> --message <text>',
  rollback_workflow: 'hatch workflow rollback <id> --version <number>',
  query_app_kv: 'hatch app kv',
  query_app_data_table: 'hatch app data-table',
  query_app_db: 'hatch app db query <id> --file <sql-path>',
};

function adapt(
  name: string,
  filename: string,
  original: string,
  guide: string,
) {
  let text = original;
  if (filename === 'SKILL.md') {
    if (name === 'building-apps') text = section(text, 'Core workflow', guide);
    if (name === 'building-workflows') {
      text = text.replace(
        /Call `checkout_workflow`[\s\S]*?serving the webhook\./,
        'Use `hatch workflow clone <id> --directory <path>` for an existing Workflow.\nRefresh that checkout with `hatch workflow update --directory <path>`.\nThe platform handles bundling, versioning, scheduling, and serving the webhook.',
      );
      text = section(text, 'Git workflow', guide);
      text = section(
        text,
        'Inspect, run & roll back',
        `## Inspect, run & roll back\n\nUse \`hatch workflow list\` and \`hatch workflow get <id>\` for state,\ncompatibility, triggers and history. Users trigger manual runs in the platform UI.\nUse \`hatch workflow rollback <id> --version <number>\` to activate a\nsupported historical deployment; refresh and rebase the local checkout afterward.\nRollback restores code, never data.\n`,
      );
      text = section(
        text,
        'Deploy & iterate',
        `## Deploy & iterate\n\nFollow the Core workflow above. Validate, commit, deploy, inspect the result,\nand explain how to trigger and watch the Workflow in the platform UI.\n`,
      );
      text = text.replace(
        /If `\.hatch\/` is missing[\s\S]*?yourself\./,
        'If `.hatch/` is missing or stale, use `hatch workflow update --directory <path>`.\nDo not recreate the SDK or import map yourself.',
      );
    }
    if (name.startsWith('importing-')) {
      const kind = name === 'importing-apps' ? 'app' : 'workflow';
      const building = `building-${kind}s`;
      text = text.replace(
        /Before downloading[\s\S]*?cannot be loaded\./,
        `Before extracting or changing source, read [${building}](../${building}/SKILL.md)\nin full with your local file-reading capability. Stop if unavailable.`,
      );
      text = text.replace(
        /Download the ZIP with `download_attachment` to its default path under\n\s*`attachments\/`\./,
        'Obtain the user-authorized local source ZIP without executing its contents.\n   Keep it in a dedicated quarantine directory outside the destination checkout.',
      );
      text = text.replace(
        /Create a new quarantine directory[\s\S]*?Stop if extraction fails\./,
        'Inspect all archive entry paths before extraction. Reject absolute paths,\n   parent traversal, symlinks, hardlinks, duplicate/case-colliding entries and\n   special files. Use bounded, traversal-safe extraction into a fresh directory;\n   stop on failure. Never extract directly into the project or checkout.',
      );
      text = text.replace(
        /in the system\s+prompt/g,
        'in the bundled compatibility Skill and live resource inspection',
      );
      text = text.replace(
        /If its compatibility version cannot be established statically,[\s\S]*?creating the destination resource\./,
        'If its compatibility version cannot be established statically, stop.\nDo not run unreviewed TypeScript to discover it. Ask for an explicit, statically\nreviewable supported declaration before creating the destination resource.',
      );
    }
    text = text.replace(
      'Load this Skill before calling App platform tools or editing an App.',
      'Read this Skill before using the Hatch CLI or editing an App.',
    );
    const match = text.match(/^---\n[\s\S]*?\n---\n/);
    if (!match) throw new Error(`Invalid frontmatter: ${name}`);
    text = text.replace(
      match[0],
      `${match[0]}\nRead [CLI contract and authentication](references/cli.md) before platform work.\n`,
    );
    text += '\n## Related product rules\n\n';
    text += dependencies[name]
      .map((dependency) => `- [${dependency}](../${dependency}/SKILL.md)\n`)
      .join('');
  }
  if (filename === 'references/data-storage.md') {
    text = text.replace(
      /For `action: 'list'`,[\s\S]*?512 characters\./,
      'Use `hatch app kv list <id>` without `--cursor` for the first page.\nIf the response has a non-null `nextCursor`, pass that exact value as `--cursor`\non the next call. Stop when it is null. A nonempty cursor is at most 512 characters.',
    );
    text = text.replace(
      'For `inspect`, omit `table` or pass',
      'For `inspect`, omit `--table` or pass',
    );
  }
  // These are parameter spellings of Agent tools, not public CLI options.
  text = text.replaceAll(
    '`allow_destructive_data_migration: true`',
    '`--allow-destructive-data-migration --data-migration-approval-token <token>`',
  );
  text = text.replaceAll('`reveal_secrets: true`', '`--reveal-secrets`');
  text = text.replaceAll(
    '`secret` property',
    '`--secret` / `--no-secret` options',
  );
  text = text.replaceAll(
    '`checkout_app`',
    '`hatch app update --directory <path>`',
  );
  text = text.replaceAll(
    '`checkout_workflow`',
    '`hatch workflow update --directory <path>`',
  );
  for (const [tool, command] of Object.entries(tools))
    text = text.replaceAll(tool, command);
  if (
    /\b(?:(?:list|get|create|checkout|deploy|rollback)_(?:apps?|workflows?)|query_app_\w+|download_attachment|read_file)\b|\bsystem prompt\b/.test(
      text,
    )
  )
    throw new Error(`Unadapted internal guidance: ${name}/${filename}`);
  return text;
}

async function files(
  root: string,
  prefix = '',
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
      throw new Error('Invalid skill resource name.');
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink())
      throw new Error('Skill sources must not contain symlinks.');
    if (stat.isDirectory()) Object.assign(result, await files(root, relative));
    else if (stat.isFile())
      result[relative] = (await readFile(path.join(root, relative))).toString(
        'base64',
      );
    else throw new Error('Skill source must contain only regular files.');
  }
  return result;
}

export async function buildCliSkills(
  root: string,
  version: string,
  commit: string | null,
): Promise<SkillBundle> {
  root = await realpath(root);
  const sourceRoot = await lstat(path.join(root, 'skills'));
  if (!sourceRoot.isDirectory() || sourceRoot.isSymbolicLink())
    throw new Error('Official skills root must be a real directory.');
  const skills: OfficialSkill[] = [];
  for (const name of Object.keys(dependencies)) {
    const source = path.join(root, 'skills', name);
    if (
      !(await lstat(source)).isDirectory() ||
      (await lstat(source)).isSymbolicLink()
    )
      throw new Error('Invalid skill source directory.');
    const contents = await files(source);
    const parsed = await loadSkills(
      new NodeExecutionEnv({ cwd: root }),
      source,
    );
    if (
      parsed.diagnostics.length ||
      parsed.skills.length !== 1 ||
      parsed.skills[0].name !== name
    )
      throw new Error(`Invalid official skill metadata: ${name}`);
    const metadata = Buffer.from(contents['SKILL.md'], 'base64').toString();
    const description = metadata.match(/^description: (.+)$/m)?.[1];
    if (!metadata.startsWith(`---\nname: ${name}\n`) || !description)
      throw new Error(`Invalid official skill metadata: ${name}`);
    const kind = name.includes('workflow') ? 'workflow' : 'app';
    const guide = await readFile(
      path.join(root, 'packages/hatch-cli/skills/lifecycle.md'),
      'utf8',
    );
    for (const [filename, encoded] of Object.entries(contents)) {
      if (!filename.endsWith('.md')) continue;
      contents[filename] = Buffer.from(
        adapt(
          name,
          filename,
          Buffer.from(encoded, 'base64').toString(),
          (kind === 'workflow'
            ? guide.replace(
                /   A destructive data migration[\s\S]*?source changes\.\n/,
                '',
              )
            : guide
          ).replaceAll('RESOURCE', kind),
        ),
      ).toString('base64');
    }
    const contract = await readFile(
      path.join(root, 'packages/hatch-cli/skills/cli.md'),
      'utf8',
    );
    contents['references/cli.md'] = Buffer.from(
      `${contract.replaceAll('APP_LATEST', String(LATEST_APP_COMPATIBILITY_VERSION)).replaceAll('APP_MINIMUM', String(MIN_SUPPORTED_APP_COMPATIBILITY_VERSION)).replaceAll('WORKFLOW_LATEST', String(LATEST_WORKFLOW_COMPATIBILITY_VERSION)).replaceAll('WORKFLOW_MINIMUM', String(MIN_SUPPORTED_WORKFLOW_COMPATIBILITY_VERSION))}\n## Bundled revision\n\nCLI ${version}; platform source ${commit ?? 'unknown'}.\n\n## Supported commands in this CLI\n\n${commandDefinitions
        .filter((command) => command.supported)
        .map(
          (command) => `- \`hatch ${command.usage}\`: ${command.description}`,
        )
        .join('\n')}\n`,
    ).toString('base64');
    skills.push({
      name,
      description: Buffer.from(contents['SKILL.md'], 'base64')
        .toString()
        .match(/^description: (.+)$/m)![1],
      files: contents,
      dependencies: dependencies[name],
    });
  }
  // Relative Markdown links are part of the shipped contract, including siblings.
  const available = new Set(
    skills.flatMap((skill) =>
      Object.keys(skill.files).map((file) => `${skill.name}/${file}`),
    ),
  );
  const reachable = (name: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(name)) return seen;
    seen.add(name);
    dependencies[name].forEach((dependency) => reachable(dependency, seen));
    return seen;
  };
  for (const skill of skills)
    for (const [filename, encoded] of Object.entries(skill.files)) {
      if (!filename.endsWith('.md')) continue;
      for (const link of Buffer.from(encoded, 'base64')
        .toString()
        .matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(link[1])) continue;
        const target = path.posix.normalize(
          path.posix.join(skill.name, path.posix.dirname(filename), link[1]),
        );
        if (
          !available.has(target) ||
          !reachable(skill.name).has(target.split('/')[0])
        )
          throw new Error(
            `Broken product skill link: ${skill.name}/${filename} -> ${link[1]}`,
          );
      }
    }
  return {
    version,
    commit,
    digest: createHash('sha256').update(JSON.stringify(skills)).digest('hex'),
    skills,
  };
}
