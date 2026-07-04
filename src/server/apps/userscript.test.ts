import { describe, expect, it } from 'vitest';
import type { NormalizedUserscript } from './manifest';
import {
  buildUserscriptMetadataBlock,
  renderUserscript,
  type UserscriptRenderContext,
} from './userscript';

const ctx: UserscriptRenderContext = {
  version: 7,
  namespace: 'hatch/app/demo/watch',
  downloadUrl: 'https://host/api/apps/demo/userscripts/watch.user.js?token=abc',
  updateUrl: 'https://host/api/apps/demo/userscripts/watch.user.js?token=abc',
};

const baseScript: NormalizedUserscript = {
  id: 'watch',
  name: 'Watch',
  url: '/api/apps/demo/userscripts/watch.user.js',
  matches: ['https://example.com/*'],
  grants: [],
  connects: [],
  noframes: false,
  extraMetadata: {},
};

/** Split a block into its `@key`/value pairs (drops the block delimiters). */
function directives(block: string): [string, string][] {
  return block
    .split('\n')
    .filter((l) => l.startsWith('// @'))
    .map((l) => {
      const rest = l.slice('// @'.length);
      const sp = rest.indexOf(' ');
      return sp === -1
        ? ([rest, ''] as [string, string])
        : ([rest.slice(0, sp), rest.slice(sp + 1)] as [string, string]);
    });
}

describe('buildUserscriptMetadataBlock', () => {
  it('wraps output in the UserScript delimiters', () => {
    const block = buildUserscriptMetadataBlock(baseScript, ctx);
    expect(block.startsWith('// ==UserScript==\n')).toBe(true);
    expect(block.endsWith('\n// ==/UserScript==')).toBe(true);
  });

  it('emits the platform-owned directives from the render context', () => {
    const d = new Map(
      directives(buildUserscriptMetadataBlock(baseScript, ctx)),
    );
    expect(d.get('name')).toBe('Watch');
    expect(d.get('namespace')).toBe('hatch/app/demo/watch');
    expect(d.get('version')).toBe('7');
    expect(d.get('updateURL')).toBe(ctx.updateUrl);
    expect(d.get('downloadURL')).toBe(ctx.downloadUrl);
  });

  it('omits @grant entirely when grants are empty (auto-detect)', () => {
    const block = buildUserscriptMetadataBlock(baseScript, ctx);
    expect(block).not.toContain('@grant');
  });

  it('emits `@grant none` for a sole none grant', () => {
    const block = buildUserscriptMetadataBlock(
      { ...baseScript, grants: ['none'] },
      ctx,
    );
    expect(block).toContain('// @grant none');
  });

  it('emits one line per match, connect, and grant', () => {
    const block = buildUserscriptMetadataBlock(
      {
        ...baseScript,
        matches: ['https://a/*', 'https://b/*'],
        connects: ['a.com', 'b.com'],
        grants: ['GM_setValue', 'GM_getValue'],
      },
      ctx,
    );
    const all = directives(block);
    expect(all.filter(([k]) => k === 'match').map(([, v]) => v)).toEqual([
      'https://a/*',
      'https://b/*',
    ]);
    expect(all.filter(([k]) => k === 'connect').map(([, v]) => v)).toEqual([
      'a.com',
      'b.com',
    ]);
    expect(all.filter(([k]) => k === 'grant').map(([, v]) => v)).toEqual([
      'GM_setValue',
      'GM_getValue',
    ]);
  });

  it('includes optional description, run-at, and noframes', () => {
    const block = buildUserscriptMetadataBlock(
      {
        ...baseScript,
        description: 'Watches prices',
        runAt: 'document-idle',
        noframes: true,
      },
      ctx,
    );
    expect(block).toContain('// @description Watches prices');
    expect(block).toContain('// @run-at document-idle');
    expect(block).toContain('// @noframes');
  });

  it('expands extraMetadata strings and arrays', () => {
    const block = buildUserscriptMetadataBlock(
      {
        ...baseScript,
        extraMetadata: {
          icon: 'https://host/icon.png',
          require: ['https://cdn/a.js', 'https://cdn/b.js'],
        },
      },
      ctx,
    );
    const all = directives(block);
    expect(all).toContainEqual(['icon', 'https://host/icon.png']);
    expect(all.filter(([k]) => k === 'require').map(([, v]) => v)).toEqual([
      'https://cdn/a.js',
      'https://cdn/b.js',
    ]);
  });

  it('collapses stray line breaks in a value so it cannot inject a line', () => {
    const block = buildUserscriptMetadataBlock(
      { ...baseScript, name: 'Evil\n// @grant GM_deleteValue' },
      ctx,
    );
    // The newline is flattened into the name value: no standalone @grant
    // directive is created, so the injection is neutralized.
    expect(directives(block).some(([key]) => key === 'grant')).toBe(false);
    const nameLine = block.split('\n').find((l) => l.startsWith('// @name'));
    expect(nameLine).toBe('// @name Evil // @grant GM_deleteValue');
  });
});

describe('renderUserscript', () => {
  it('places the metadata block before the bundled body', () => {
    const out = renderUserscript(baseScript, ctx, 'console.log(1);');
    expect(out.startsWith('// ==UserScript==')).toBe(true);
    expect(out.endsWith('console.log(1);')).toBe(true);
    expect(out.indexOf('// ==/UserScript==')).toBeLessThan(
      out.indexOf('console.log(1);'),
    );
  });
});
