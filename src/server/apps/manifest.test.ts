import { describe, expect, it } from 'vitest';
import {
  normalizeManifest,
  parseSourceManifest,
  snapToSupportedSize,
} from './manifest';

describe('app capabilities manifest', () => {
  const manifest = (capabilities: Record<string, unknown>) => ({
    id: 'demo',
    name: 'Demo',
    capabilities,
  });

  it('accepts known capabilities and applies their defaults', () => {
    const parsed = parseSourceManifest(manifest({ backend: true }));

    expect(parsed.capabilities).toMatchObject({
      backend: true,
      frontend: false,
      kv: false,
    });
  });

  it('rejects the retired storage capability and other unknown fields', () => {
    expect(() =>
      parseSourceManifest(manifest({ backend: true, storage: true })),
    ).toThrow(/storage/);
    expect(() =>
      parseSourceManifest(manifest({ backend: true, madeUp: true })),
    ).toThrow(/madeUp/);
  });

  it('does not emit a storage flag or URL when normalizing', () => {
    const normalized = normalizeManifest(
      parseSourceManifest(manifest({ backend: true, kv: true })),
    );

    expect(normalized.capabilities).not.toHaveProperty('storage');
    expect(normalized).not.toHaveProperty('storage');
  });
});

describe('app route manifest', () => {
  const parseRoutes = (routes?: unknown[]) =>
    normalizeManifest(
      parseSourceManifest({
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.tsx',
          ...(routes === undefined ? {} : { routes }),
        },
      }),
    ).app?.routes;

  it('normalizes static and dynamic route metadata', () => {
    expect(
      parseRoutes([
        { path: '/', description: 'Overview' },
        { path: '/projects/$projectId', description: 'Project details' },
      ]),
    ).toEqual([
      { path: '/', description: 'Overview' },
      { path: '/projects/$projectId', description: 'Project details' },
    ]);
  });

  it('defaults routes to an empty list for existing manifests', () => {
    expect(parseRoutes()).toEqual([]);
  });

  it('rejects duplicate route paths', () => {
    expect(() =>
      parseRoutes([
        { path: '/settings', description: 'Settings' },
        { path: '/settings', description: 'Other settings' },
      ]),
    ).toThrow(/duplicate app route path/);
  });

  it('rejects relative paths and empty or multiline descriptions', () => {
    expect(() =>
      parseRoutes([{ path: 'settings', description: 'Settings' }]),
    ).toThrow(/route path must start/);
    expect(() => parseRoutes([{ path: '/', description: '' }])).toThrow(
      /description/,
    );
    expect(() => parseRoutes([{ path: '/', description: '   ' }])).toThrow(
      /must not be blank/,
    );
    expect(() =>
      parseRoutes([{ path: '/', description: 'Home\nroute' }]),
    ).toThrow(/must not contain line breaks/);
  });
});

describe('snapToSupportedSize', () => {
  it('returns undefined for an empty list (free-form fallback)', () => {
    expect(snapToSupportedSize([], { w: 4, h: 3 })).toBeUndefined();
  });

  it('picks the nearest footprint by grid-unit distance', () => {
    const sizes = [
      { w: 2, h: 2 },
      { w: 6, h: 6 },
    ];
    expect(snapToSupportedSize(sizes, { w: 3, h: 3 })).toEqual({ w: 2, h: 2 });
    expect(snapToSupportedSize(sizes, { w: 5, h: 5 })).toEqual({ w: 6, h: 6 });
  });

  it('breaks ties toward the first declared size', () => {
    const sizes = [
      { w: 2, h: 2 },
      { w: 4, h: 4 },
    ];
    expect(snapToSupportedSize(sizes, { w: 3, h: 3 })).toEqual({ w: 2, h: 2 });
  });
});

describe('normalizeManifest widgets', () => {
  const normalize = (widget: Record<string, unknown>) =>
    normalizeManifest(
      parseSourceManifest({
        id: 'demo',
        name: 'Demo',
        capabilities: { widgets: true },
        widgets: [{ id: 'w', name: 'W', entry: 'widgets/w.tsx', ...widget }],
      }),
    ).widgets[0];

  it('de-duplicates supportedSizes preserving author order', () => {
    const w = normalize({
      defaultSize: { w: 4, h: 3 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 4, h: 3 },
        { w: 3, h: 2 },
      ],
    });
    expect(w.supportedSizes).toEqual([
      { w: 3, h: 2 },
      { w: 4, h: 3 },
    ]);
  });

  it('snaps defaultSize into the supported set when it is not a member', () => {
    const w = normalize({
      defaultSize: { w: 5, h: 5 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 4, h: 3 },
      ],
    });
    expect(w.defaultSize).toEqual({ w: 4, h: 3 });
  });

  it('keeps a defaultSize that is already supported', () => {
    const w = normalize({
      defaultSize: { w: 3, h: 2 },
      supportedSizes: [
        { w: 3, h: 2 },
        { w: 6, h: 4 },
      ],
    });
    expect(w.defaultSize).toEqual({ w: 3, h: 2 });
  });

  it('leaves supportedSizes empty (free-form) when undeclared', () => {
    const w = normalize({ defaultSize: { w: 4, h: 3 } });
    expect(w.supportedSizes).toEqual([]);
    expect(w.defaultSize).toEqual({ w: 4, h: 3 });
  });
});

describe('userscripts manifest', () => {
  const withScripts = (
    scripts: Record<string, unknown>[],
    capabilityOn = true,
  ) => ({
    id: 'demo',
    name: 'Demo',
    capabilities: { userscripts: capabilityOn },
    userscripts: scripts,
  });

  const baseScript = {
    id: 'watch',
    name: 'Watch',
    entry: 'userscripts/watch.ts',
    matches: ['https://example.com/*'],
  };

  it('accepts a valid declaration and normalizes it', () => {
    const normalized = normalizeManifest(
      parseSourceManifest(
        withScripts([
          {
            ...baseScript,
            description: 'Watches',
            grants: ['GM_setValue', 'GM_getValue'],
            connects: ['api.example.com'],
            runAt: 'document-idle',
            noframes: true,
            extraMetadata: { require: 'https://cdn/x.js' },
          },
        ]),
      ),
    );
    expect(normalized.userscripts).toEqual([
      {
        id: 'watch',
        name: 'Watch',
        url: '/api/apps/demo/userscripts/watch.user.js',
        matches: ['https://example.com/*'],
        description: 'Watches',
        grants: ['GM_setValue', 'GM_getValue'],
        connects: ['api.example.com'],
        runAt: 'document-idle',
        noframes: true,
        extraMetadata: { require: 'https://cdn/x.js' },
      },
    ]);
  });

  it('omits userscripts from the normalized manifest when capability is off', () => {
    const normalized = normalizeManifest(
      parseSourceManifest(withScripts([baseScript], false)),
    );
    expect(normalized.userscripts).toBeUndefined();
  });

  it('rejects an enabled capability with no scripts', () => {
    expect(() => parseSourceManifest(withScripts([]))).toThrow(
      /no userscripts are declared/,
    );
  });

  it('rejects an unsafe entry path', () => {
    expect(() =>
      parseSourceManifest(
        withScripts([{ ...baseScript, entry: '../../secret.ts' }]),
      ),
    ).toThrow(/relative path inside the app source/);
  });

  it('rejects an id with path separators', () => {
    expect(() =>
      parseSourceManifest(withScripts([{ ...baseScript, id: 'a/b' }])),
    ).toThrow(/userscript id must contain/);
  });

  it('rejects a script with no match patterns', () => {
    expect(() =>
      parseSourceManifest(withScripts([{ ...baseScript, matches: [] }])),
    ).toThrow(/at least one match/);
  });

  it('rejects line breaks in metadata (injection guard)', () => {
    expect(() =>
      parseSourceManifest(
        withScripts([
          { ...baseScript, name: 'Watch\n// @grant GM_deleteValue' },
        ]),
      ),
    ).toThrow(/must not contain line breaks/);
    expect(() =>
      parseSourceManifest(
        withScripts([{ ...baseScript, matches: ['https://x/*\n// @run-at'] }]),
      ),
    ).toThrow(/must not contain line breaks/);
  });

  it('rejects mixing "none" with other grants', () => {
    expect(() =>
      parseSourceManifest(
        withScripts([{ ...baseScript, grants: ['none', 'GM_setValue'] }]),
      ),
    ).toThrow(/cannot be combined with other grants/);
  });

  it('accepts a sole "none" grant', () => {
    const normalized = normalizeManifest(
      parseSourceManifest(withScripts([{ ...baseScript, grants: ['none'] }])),
    );
    expect(normalized.userscripts?.[0]?.grants).toEqual(['none']);
  });

  it('rejects platform-owned keys in extraMetadata', () => {
    // `include`/`exclude`/`exclude-match` change which pages the script runs
    // on, so they must go through the structured `matches` field — otherwise a
    // manifest could widen its scope beyond what the manage UI displays.
    for (const key of [
      'name',
      'version',
      'match',
      'downloadURL',
      'grant',
      'include',
      'exclude',
      'exclude-match',
      'Include',
    ]) {
      expect(() =>
        parseSourceManifest(
          withScripts([{ ...baseScript, extraMetadata: { [key]: 'x' } }]),
        ),
      ).toThrow(/platform-managed key/);
    }
  });

  it('rejects duplicate script ids', () => {
    expect(() =>
      parseSourceManifest(withScripts([baseScript, { ...baseScript }])),
    ).toThrow(/duplicate userscript id/);
  });

  it('defaults optional fields (empty grants/connects, noframes false)', () => {
    const normalized = normalizeManifest(
      parseSourceManifest(withScripts([baseScript])),
    );
    const script = normalized.userscripts?.[0];
    expect(script?.grants).toEqual([]);
    expect(script?.connects).toEqual([]);
    expect(script?.noframes).toBe(false);
    expect(script?.runAt).toBeUndefined();
    expect(script?.description).toBeUndefined();
    expect(script?.extraMetadata).toEqual({});
  });
});
