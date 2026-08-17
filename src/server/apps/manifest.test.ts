import { describe, expect, it } from 'vitest';
import { APP_NAME_MAX_LENGTH, APP_SLUG_MAX_LENGTH } from '~/app-identity';
import {
  isValidAppSlug,
  type NormalizedManifest,
  normalizeManifest,
  parseSourceManifest,
  projectAppManifestUrls,
  snapToSupportedSize,
  sourceManifestSchema,
} from './manifest';

describe('App identity limits', () => {
  it('accepts Unicode App names and slugs at the 64-character boundary', () => {
    const name = '😀'.repeat(APP_NAME_MAX_LENGTH);
    const slug = `a${'b'.repeat(APP_SLUG_MAX_LENGTH - 1)}`;

    expect(
      parseSourceManifest({ id: 'demo', name, capabilities: {} }).name,
    ).toBe(name);
    expect(isValidAppSlug(slug)).toBe(true);
  });

  it('rejects App names and slugs above the 64-character boundary', () => {
    expect(() =>
      parseSourceManifest({
        id: 'demo',
        name: '😀'.repeat(APP_NAME_MAX_LENGTH + 1),
        capabilities: {},
      }),
    ).toThrow(/64/);
    expect(isValidAppSlug(`a${'b'.repeat(APP_SLUG_MAX_LENGTH)}`)).toBe(false);
  });
});

describe('backend manifest', () => {
  const source = (backend: Record<string, unknown>) => ({
    id: 'demo',
    name: 'Demo',
    capabilities: { backend: true },
    backend: { entry: 'backend/main.ts', ...backend },
  });

  it('rejects the removed backend assets field instead of stripping it', () => {
    const result = sourceManifestSchema.safeParse(
      source({ assets: ['backend/assets'] }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['assets'],
        path: ['backend'],
      }),
    );
  });

  it.each([
    'backend/assets',
    'backend/assets/main.ts',
    'backend/./assets/main.ts',
  ])('rejects the reserved assets directory as backend entry: %s', (entry) => {
    expect(() => parseSourceManifest(source({ entry }))).toThrow(
      /reserved.*backend\/assets/,
    );
  });

  it('supports bundle-v1 while legacy normalized manifests omit format', () => {
    const legacy: NormalizedManifest = normalizeManifest(
      parseSourceManifest(source({})),
    );
    const bundled: NormalizedManifest = {
      ...legacy,
      backend: {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
      },
    };

    expect(legacy.backend).toEqual({ entry: 'backend/main.ts' });
    expect(bundled.backend).toEqual({
      entry: 'backend/main.bundle.js',
      format: 'bundle-v1',
    });
  });
});

describe('app capabilities manifest', () => {
  const manifest = (capabilities: Record<string, unknown>) => ({
    id: 'demo',
    name: 'Demo',
    capabilities,
  });

  it('accepts known capabilities and applies their defaults', () => {
    const parsed = parseSourceManifest(manifest({}));

    expect(parsed.capabilities).toMatchObject({
      backend: false,
      frontend: false,
      storage: false,
      kv: false,
    });
  });

  it('accepts and preserves storage: false', () => {
    const parsed = parseSourceManifest(manifest({ storage: false }));
    const normalized = normalizeManifest(parsed);

    expect(parsed.capabilities.storage).toBe(false);
    expect(normalized.capabilities.storage).toBe(false);
    expect(normalized).not.toHaveProperty('storage');
  });

  it('accepts storage for a declared backend', () => {
    const parsed = parseSourceManifest({
      ...manifest({ backend: true, storage: true }),
      backend: { entry: 'backend/main.ts' },
    });
    const normalized = normalizeManifest(parsed);

    expect(parsed.capabilities.storage).toBe(true);
    expect(normalized.capabilities.storage).toBe(true);
    expect(normalized).not.toHaveProperty('storage');
  });

  it('accepts and strips the retired userscripts: false field', () => {
    const parsed = parseSourceManifest(manifest({ userscripts: false }));
    const normalized = normalizeManifest(parsed);

    expect(parsed.capabilities).not.toHaveProperty('userscripts');
    expect(normalized.capabilities).not.toHaveProperty('userscripts');
    expect(normalized).not.toHaveProperty('userscripts');
  });

  it('rejects the retired userscripts capability when enabled', () => {
    expect(() => parseSourceManifest(manifest({ userscripts: true }))).toThrow(
      /userscripts/,
    );
  });

  it('requires both the backend capability and backend entry for storage', () => {
    expect(() =>
      parseSourceManifest({
        ...manifest({ storage: true }),
        backend: { entry: 'backend/main.ts' },
      }),
    ).toThrow(/storage requires capabilities\.backend and backend\.entry/);
    expect(() =>
      parseSourceManifest(manifest({ backend: true, storage: true })),
    ).toThrow(/storage requires capabilities\.backend and backend\.entry/);
  });

  it('rejects unknown capability fields', () => {
    expect(() =>
      parseSourceManifest(manifest({ backend: true, madeUp: true })),
    ).toThrow(/madeUp/);
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

  it('projects every legacy URL from current identity without mutation', () => {
    const normalized = normalizeManifest(
      parseSourceManifest({
        id: '01internalid',
        name: 'Demo',
        capabilities: { frontend: true },
        app: { entry: 'app/main.tsx' },
      }),
    );
    const stored = {
      ...normalized,
      capabilities: { ...normalized.capabilities, userscripts: true },
      app: { url: '/api/apps/legacy-id/app/', routes: [] },
      widgets: [
        {
          id: 'summary',
          name: 'Summary',
          url: '/api/apps/legacy-id/widget/summary',
          defaultSize: { w: 4, h: 3 },
          supportedSizes: [],
        },
      ],
      userscripts: [
        {
          id: 'watch',
          name: 'Watch',
          url: '/api/apps/legacy-id/userscripts/watch.user.js',
          matches: ['https://example.com/*'],
          grants: [],
          connects: [],
          noframes: false,
          extraMetadata: {},
        },
      ],
      rpc: {
        url: '/api/apps/legacy-id/rpc',
        service: 'demo.v1.DemoService',
      },
      kv: { url: '/api/apps/legacy-id/kv' },
      dataTable: { url: '/api/apps/legacy-id/data' },
      webhook: { url: '/api/hooks/01internalid', auth: 'platform' },
    } as NormalizedManifest & {
      capabilities: NormalizedManifest['capabilities'] & {
        userscripts: boolean;
      };
      userscripts: unknown[];
    };
    const before = structuredClone(stored);

    const projected = projectAppManifestUrls(
      stored,
      '01authoritativeid',
      'friendly-demo',
    );

    expect(projected.app?.url).toBe('/app/friendly-demo/embed/');
    expect(projected.widgets[0]?.url).toBe(
      '/api/app/01authoritativeid/widget/summary',
    );
    expect(projected).not.toHaveProperty('userscripts');
    expect(projected.capabilities).not.toHaveProperty('userscripts');
    expect(projected.rpc?.url).toBe('/api/app/01authoritativeid/rpc');
    expect(projected.kv?.url).toBe('/api/app/01authoritativeid/kv');
    expect(projected.dataTable?.url).toBe('/api/app/01authoritativeid/data');
    expect(projected.webhook).toEqual(stored.webhook);
    expect(stored).toEqual(before);
  });

  it.each([
    '.hatch/app.tsx',
    '.HATCH/app.tsx',
    './.HaTcH/app.tsx',
    './.hatch/app.tsx',
    './/.hatch/app.tsx',
    '.\\.hatch\\app.tsx',
    'app/.hatch/main.tsx',
    'app/.HATCH/main.tsx',
    'app\\.hatch\\main.tsx',
    'app\\.HaTcH\\main.tsx',
  ])(
    'rejects entries inside the platform-owned .hatch directory: %s',
    (entry) => {
      expect(() =>
        parseSourceManifest({
          id: 'demo',
          name: 'Demo',
          capabilities: { frontend: true },
          app: { entry },
        }),
      ).toThrow(/platform-owned.*\.hatch/);
    },
  );

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

describe('capability entry contracts', () => {
  it.each([
    [{ frontend: true }, /app\.entry is not declared/],
    [{ backend: true }, /backend\.entry is not declared/],
    [{ widgets: true }, /no widgets are declared/],
  ] as const)(
    'rejects an enabled capability without an entry',
    (capabilities, error) => {
      expect(() =>
        parseSourceManifest({ id: 'demo', name: 'Demo', capabilities }),
      ).toThrow(error);
    },
  );

  it('rejects an RPC declaration without an enabled backend entry', () => {
    expect(() =>
      parseSourceManifest({
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: { entry: 'app/main.tsx' },
        rpc: {
          proto: 'proto/service.proto',
          service: 'app.v1.DemoService',
        },
      }),
    ).toThrow(/rpc requires capabilities\.backend/);
  });

  it('requires the RPC proto declaration to name a .proto file', () => {
    expect(() =>
      parseSourceManifest({
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
        rpc: { proto: 'proto/service', service: 'app.v1.DemoService' },
      }),
    ).toThrow(/proto entry must name a \.proto file/);
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
