import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: `/tmp/hatch-build-identity-${process.pid}`,
  deployment: undefined as
    | { artifactPath: string | null; manifestNormalized?: unknown }
    | undefined,
}));

vi.mock('~agent/paths', () => ({
  appBuildDir: (id: string) => `${state.root}/${id}`,
  deploymentArtifactDir: (id: string, deploymentId: string) =>
    `${state.root}/artifacts/${id}/${deploymentId}`,
  deploymentBuildDir: (id: string, deploymentId: string) =>
    `${state.root}/versions/${id}/${deploymentId}`,
}));

vi.mock('~/db', () => ({
  db: {
    query: {
      deployments: {
        findFirst: async () => state.deployment,
      },
    },
  },
}));

import {
  buildMatchesDeployment,
  liveBuildMatchesDeployment,
  readBuildDeploymentMarker,
  readLiveBuildFile,
} from './build-identity';

afterEach(async () => {
  vi.restoreAllMocks();
  state.deployment = undefined;
  await fs.rm(state.root, { recursive: true, force: true });
});

describe('live build deployment identity', () => {
  it('accepts legacy builds without a marker', async () => {
    state.deployment = { artifactPath: null };
    const dir = path.join(state.root, 'legacy');
    await fs.mkdir(path.join(dir, 'app'), { recursive: true });
    await fs.writeFile(path.join(dir, 'app', 'index.html'), 'legacy', 'utf8');
    await expect(
      liveBuildMatchesDeployment('legacy', 'deployment-v1'),
    ).resolves.toBe(true);
    await expect(
      readLiveBuildFile('legacy', 'deployment-v1', 'app/index.html'),
    ).resolves.toMatchObject({ ok: true, data: Buffer.from('legacy') });
  });

  it('accepts only the exact id from a present valid marker', async () => {
    const dir = path.join(state.root, 'current');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v2' }),
      'utf8',
    );

    await expect(
      liveBuildMatchesDeployment('current', 'deployment-v2'),
    ).resolves.toBe(true);
    await expect(
      liveBuildMatchesDeployment('current', 'deployment-v1'),
    ).resolves.toBe(false);
  });

  it('fails closed for a malformed marker', async () => {
    const dir = path.join(state.root, 'broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'deployment.json'), '{', 'utf8');

    await expect(
      liveBuildMatchesDeployment('broken', 'deployment-v1'),
    ).resolves.toBe(false);
    expect(readBuildDeploymentMarker(dir)).toEqual({ kind: 'invalid' });
  });

  it('distinguishes a legacy missing marker from a damaged marker', async () => {
    const dir = path.join(state.root, 'legacy-marker');
    await fs.mkdir(dir, { recursive: true });

    expect(readBuildDeploymentMarker(dir)).toEqual({ kind: 'missing' });
    await fs.writeFile(
      path.join(dir, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v1' }),
      'utf8',
    );
    expect(readBuildDeploymentMarker(dir)).toEqual({
      kind: 'deployment',
      id: 'deployment-v1',
    });
  });

  it('does not mistake a missing current marker for a modern legacy build', async () => {
    const live = path.join(state.root, 'modern');
    const artifact = path.join(
      state.root,
      'artifacts',
      'modern',
      'deployment-v2',
    );
    await fs.mkdir(path.join(live, 'app'), { recursive: true });
    await fs.writeFile(path.join(live, 'app', 'index.html'), 'bytes', 'utf8');
    await fs.mkdir(artifact, { recursive: true });
    await fs.writeFile(
      path.join(artifact, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v2' }),
      'utf8',
    );

    await expect(
      liveBuildMatchesDeployment('modern', 'deployment-v2'),
    ).resolves.toBe(false);
    await expect(
      readLiveBuildFile('modern', 'deployment-v2', 'app/index.html'),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects a live-only missing marker for a modern deployment record', async () => {
    state.deployment = {
      artifactPath: 'artifacts/modern/deployment-v2',
      manifestNormalized: { capabilities: { dataTable: false } },
    };
    const live = path.join(state.root, 'missing-modern');
    await fs.mkdir(path.join(live, 'app'), { recursive: true });
    await fs.writeFile(path.join(live, 'app', 'index.html'), 'bytes', 'utf8');

    await expect(
      liveBuildMatchesDeployment('missing-modern', 'deployment-v2'),
    ).resolves.toBe(false);
    await expect(
      buildMatchesDeployment('missing-modern', 'deployment-v2', live),
    ).resolves.toBe(false);
  });

  it('accepts a markerless immutable snapshot as legacy evidence', async () => {
    state.deployment = {
      artifactPath: 'artifacts/legacy/deployment-v1',
      manifestNormalized: { capabilities: { backend: true } },
    };
    const artifact = path.join(
      state.root,
      'artifacts',
      'snapshot-legacy',
      'deployment-v1',
    );
    await fs.mkdir(path.join(artifact, 'backend'), { recursive: true });
    await fs.writeFile(path.join(artifact, 'backend', 'main.ts'), '', 'utf8');

    await expect(
      buildMatchesDeployment('snapshot-legacy', 'deployment-v1', artifact),
    ).resolves.toBe(true);
  });

  it('rejects a markerless immutable snapshot from the Data Table era', async () => {
    state.deployment = {
      artifactPath: 'artifacts/modern/deployment-v2',
      manifestNormalized: { capabilities: { dataTable: false } },
    };
    const artifact = path.join(
      state.root,
      'artifacts',
      'snapshot-modern',
      'deployment-v2',
    );
    await fs.mkdir(path.join(artifact, 'backend'), { recursive: true });
    await fs.writeFile(path.join(artifact, 'backend', 'main.ts'), '', 'utf8');

    await expect(
      buildMatchesDeployment('snapshot-modern', 'deployment-v2', artifact),
    ).resolves.toBe(false);
  });

  it('reads only a stable file from the selected deployment', async () => {
    const dir = path.join(state.root, 'stable');
    await fs.mkdir(path.join(dir, 'widgets'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v3' }),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'widgets', 'clock.js'), 'clock', 'utf8');

    const result = await readLiveBuildFile(
      'stable',
      'deployment-v3',
      'widgets/clock.js',
    );
    expect(result).toMatchObject({ ok: true });
    expect('data' in result ? result.data.toString('utf8') : null).toBe(
      'clock',
    );
    await expect(
      readLiveBuildFile('stable', 'deployment-v3', '../secret'),
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(
      readLiveBuildFile('stable', 'deployment-v3', 'widgets/missing.js'),
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('treats a missing file during live-directory cutover as unavailable', async () => {
    const live = path.join(state.root, 'missing-during-cutover');
    const replacement = path.join(state.root, 'replacement-cutover');
    const displaced = path.join(state.root, 'displaced-cutover');
    await fs.mkdir(path.join(live, 'app'), { recursive: true });
    await fs.writeFile(
      path.join(live, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v1' }),
      'utf8',
    );
    await fs.writeFile(path.join(live, 'app', 'index.html'), 'old', 'utf8');
    await fs.mkdir(replacement, { recursive: true });
    await fs.writeFile(
      path.join(replacement, 'deployment.json'),
      JSON.stringify({ deploymentId: 'deployment-v2' }),
      'utf8',
    );

    vi.spyOn(fs, 'stat').mockImplementationOnce(async () => {
      // Deliver the ENOENT observed after v1 moved away only after v2 has
      // become live. The follow-up marker check must identify the cutover.
      await fs.rename(live, displaced);
      const missing = Object.assign(new Error('file disappeared'), {
        code: 'ENOENT',
      });
      await fs.rename(replacement, live);
      throw missing;
    });

    await expect(
      readLiveBuildFile(
        'missing-during-cutover',
        'deployment-v1',
        'app/index.html',
      ),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects bytes opened from a deployment swapped in and back', async () => {
    const live = path.join(state.root, 'racing');
    const replacement = path.join(state.root, 'replacement');
    const displaced = path.join(state.root, 'displaced');
    for (const [dir, deploymentId, body] of [
      [live, 'deployment-v1', 'old'],
      [replacement, 'deployment-v2', 'new'],
    ] as const) {
      await fs.mkdir(path.join(dir, 'app'), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'deployment.json'),
        JSON.stringify({ deploymentId }),
        'utf8',
      );
      await fs.writeFile(path.join(dir, 'app', 'index.html'), body, 'utf8');
    }

    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
      // The helper already statted v1. Make its open resolve v2, then restore v1
      // before the post-read marker check. Marker-before/after alone would miss
      // this ABA transition; the pinned descriptor identity must catch it.
      await fs.rename(live, displaced);
      await fs.rename(replacement, live);
      const handle = await originalOpen(file, flags, mode);
      await fs.rename(live, replacement);
      await fs.rename(displaced, live);
      return handle;
    });

    await expect(
      readLiveBuildFile('racing', 'deployment-v1', 'app/index.html'),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});
