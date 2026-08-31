/** Server-only: compile a workflow source tree into a single-file program. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  hatchImportMapPath,
  materializeWorkflowHatchSdk,
} from '~agent/hatch-sdk';
import { WORKFLOW_BUILD_WORK_DIR } from '~agent/paths';
import { validateDenoDependencySource } from '../deno-dependencies';
import { run } from '../subprocess';
import {
  type NormalizedWorkflowManifest,
  type SourceWorkflowManifest,
  normalizeWorkflowManifest,
  parseSourceWorkflowManifest,
} from './manifest';
import { buildWorkflowDenoArgs } from './runtime-permissions';
import { workflowSandboxEnv } from './sandbox-env';

export type WorkflowBuildResult = {
  source: SourceWorkflowManifest;
  normalized: NormalizedWorkflowManifest;
  /** JSON Schema (draft 2020-12) of the workflow input. */
  inputSchema: Record<string, unknown>;
  /** Absolute path to the bundled single-file program in the output dir. */
  bundlePath: string;
  log: string;
};

export type BuildWorkflowOptions = {
  sourceDir: string;
  outputDir: string;
};

const SENTINEL = '[[hatch]]';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(src: string): Promise<SourceWorkflowManifest> {
  const raw = await fs.readFile(path.join(src, 'manifest.json'), 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `manifest.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  return parseSourceWorkflowManifest(json);
}

/** Find the JSON object carried on the first `[[hatch]]` event line of a kind. */
function parseSentinel(stdout: string, kind: string): unknown {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(SENTINEL)) continue;
    try {
      const event = JSON.parse(line.slice(SENTINEL.length)) as {
        t?: string;
        schema?: unknown;
      };
      if (event.t === kind) return event;
    } catch {
      /* ignore malformed lines */
    }
  }
  return null;
}

export async function buildWorkflow(
  id: string,
  options: BuildWorkflowOptions,
): Promise<WorkflowBuildResult> {
  const originalSrc = options.sourceDir;
  const out = options.outputDir;
  const logs: string[] = [];

  if (!(await pathExists(originalSrc))) {
    throw new Error(`Workflow source not found: ${originalSrc}`);
  }

  const tempSrc = path.join(WORKFLOW_BUILD_WORK_DIR, id, randomUUID());
  await fs.rm(tempSrc, { recursive: true, force: true });
  await fs.mkdir(path.dirname(tempSrc), { recursive: true });
  await fs.cp(originalSrc, tempSrc, {
    recursive: true,
    // Reproduce dependencies from committed metadata and replace generated
    // roots below. Never trust an SDK or node_modules supplied by source.
    filter: (source) => {
      const relative = path
        .relative(originalSrc, source)
        .split(path.sep)
        .join('/');
      const rootEntry = relative.split('/', 1)[0]?.toLowerCase();
      return !['.git', '.hatch', 'node_modules'].includes(rootEntry);
    },
  });

  try {
    const manifest = await readManifest(tempSrc);

    await validateDenoDependencySource(tempSrc, 'workflow');

    if (await pathExists(path.join(tempSrc, 'hatch', 'workflow.ts'))) {
      throw new Error(
        'Workflow source contains the retired hatch/workflow.ts SDK. Remove ' +
          'the source-owned SDK and use the platform-generated .hatch SDK.',
      );
    }

    const entry = path.join(tempSrc, manifest.entry);
    if (!(await pathExists(entry))) {
      throw new Error(`workflow entry not found: ${manifest.entry}`);
    }

    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });

    // Materialize the authoritative SDK and generate only the per-build runner
    // wrapper. User source keeps the stable @hatch/workflow import without
    // owning the SDK implementation or its import map.
    await materializeWorkflowHatchSdk(tempSrc);
    const entryImport = `./${manifest.entry.replace(/\\/g, '/')}`;
    const wrapper = path.join(tempSrc, '__hatch_main.ts');
    await fs.writeFile(
      wrapper,
      // JSON.stringify the specifier so an entry path with quotes/backslashes
      // can't break out of the import string (entry is already constrained to a
      // safe relative path by the manifest schema; this is defense in depth).
      `import workflow from ${JSON.stringify(entryImport)};\n` +
        `import { runCli } from '@hatch/workflow';\n` +
        'await runCli(workflow);\n',
      'utf8',
    );

    // 1) Reproduce the source-controlled dependency graph. Deno reads reviewed
    // allowScripts entries from deno.json; --frozen rejects uncommitted changes.
    const installArgs = [
      'install',
      '--package-json',
      '--node-modules-dir=auto',
      '--lock=deno.lock',
      '--frozen',
    ];
    const install = await run('deno', installArgs, {
      cwd: tempSrc,
      env: workflowSandboxEnv(),
    });
    logs.push(
      `$ deno ${installArgs.join(' ')}\n${(
        install.stderr || install.stdout
      ).trim()}`,
    );
    if (install.code !== 0) {
      throw new Error(
        'Workflow dependency install failed with the committed deno.lock. ' +
          'Load the "building-workflows" Skill, run deno install locally, ' +
          `commit the updated dependency files, and deploy again:\n${
            install.stderr || install.stdout
          }`,
      );
    }

    // 2) Bundle the workflow + its npm deps into one Deno-runnable file.
    const bundlePath = path.join(out, 'workflow.js');
    const bundleArgs = [
      'bundle',
      '--node-modules-dir=auto',
      '--lock=deno.lock',
      '--frozen',
      '--import-map',
      hatchImportMapPath(tempSrc),
      '-o',
      bundlePath,
      wrapper,
    ];
    const bundle = await run('deno', bundleArgs, {
      cwd: tempSrc,
      env: workflowSandboxEnv(),
    });
    logs.push(
      `$ deno ${bundleArgs.join(' ')}\n${(
        bundle.stderr || bundle.stdout
      ).trim()}`,
    );
    if (bundle.code !== 0 || !(await pathExists(bundlePath))) {
      throw new Error(
        `Workflow bundle failed:\n${bundle.stderr || bundle.stdout}`,
      );
    }

    // 3) Run the bundle in describe mode to capture the input JSON Schema.
    const describe = await run(
      'deno',
      // Describe mode imports and evaluates the same author-written bundle as a
      // real run, so it must use the identical network permission contract.
      buildWorkflowDenoArgs({
        bundlePath,
        artifactDir: out,
        network: manifest.network,
      }),
      { cwd: tempSrc, env: workflowSandboxEnv({ HATCH_MODE: 'describe' }) },
    );
    if (describe.code !== 0) {
      throw new Error(
        `Failed to read workflow input schema:\n${
          describe.stderr || describe.stdout
        }`,
      );
    }
    const schemaEvent = parseSentinel(describe.stdout, 'schema') as {
      schema?: Record<string, unknown>;
    } | null;
    if (!schemaEvent || !schemaEvent.schema) {
      throw new Error(
        'Workflow did not emit an input schema. Ensure it uses ' +
          '`export default defineWorkflow(...)`.',
      );
    }
    const inputSchema = schemaEvent.schema;
    logs.push('captured input schema');

    const normalized = normalizeWorkflowManifest(manifest);
    await fs.writeFile(
      path.join(out, 'manifest.normalized.json'),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(out, 'input.schema.json'),
      JSON.stringify(inputSchema, null, 2),
      'utf8',
    );

    return {
      source: manifest,
      normalized,
      inputSchema,
      bundlePath,
      log: logs.join('\n'),
    };
  } finally {
    await fs.rm(tempSrc, { recursive: true, force: true });
  }
}
