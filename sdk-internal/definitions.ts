/** Public SDK exports are the shared build and resolution contract. */
import appManifest from './app/package.json' with { type: 'json' };
import dataManifest from './data/package.json' with { type: 'json' };
import workflowManifest from './workflow/package.json' with { type: 'json' };

type SdkManifest = {
  name: string;
  exports: Record<string, { types: string; default: string }>;
  peerDependencies: Record<string, string>;
};

type SdkEntry = { source: string } | { reexport: string };

export type SdkDefinition = {
  directory: string;
  manifest: SdkManifest;
  entries: Record<string, SdkEntry>;
};

export const APP_SDK: SdkDefinition = {
  directory: 'app',
  manifest: appManifest,
  entries: {
    '.': { source: 'app.ts' },
    './data': { source: 'data.ts' },
    './data/react': { source: 'data-react.ts' },
  },
};

export const LEGACY_DATA_SDK: SdkDefinition = {
  directory: 'data',
  manifest: dataManifest,
  entries: {
    '.': { reexport: '@hatch/app/data' },
    './react': { reexport: '@hatch/app/data/react' },
  },
};

export const WORKFLOW_SDK: SdkDefinition = {
  directory: 'workflow',
  manifest: workflowManifest,
  entries: {
    '.': { source: 'workflow.ts' },
    './manifest': { source: 'manifest.ts' },
  },
};

export const SDK_DEFINITIONS = [APP_SDK, LEGACY_DATA_SDK, WORKFLOW_SDK];

export function sdkImports(
  definitions: readonly SdkDefinition[],
): Record<string, string> {
  return Object.fromEntries(
    definitions.flatMap(({ manifest }) =>
      Object.entries(manifest.exports).map(([key, entry]) => [
        key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`,
        `./sdk/${manifest.name}/${entry.default.slice(2)}`,
      ]),
    ),
  );
}
