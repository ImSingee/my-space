// @ts-self-types="./app.d.ts"
import type { z } from 'zod';
import type { sourceManifestSchema } from '../../../packages/hatch-manifest/src/app-schema.js';

export type AppManifestInput = z.input<typeof sourceManifestSchema>;

/** Declare source configuration without executing platform operations. */
export function defineAppManifest(
  manifest: AppManifestInput,
): AppManifestInput {
  return manifest;
}
