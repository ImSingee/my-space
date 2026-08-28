import { describe, expect, it } from 'vitest';
import {
  compactComposerInput,
  composerDisplayText,
  composerInputSchema,
  composerModelText,
  hasComposerText,
} from './composer-content';

describe('Agent Composer content', () => {
  it('serializes App references differently for the UI and model', () => {
    const content = [
      { type: 'text' as const, text: 'Match ' },
      {
        type: 'app' as const,
        id: 'app-1',
        name: 'Meal "Planner"',
        slug: 'meal-planner',
      },
      { type: 'text' as const, text: '\nthen compare it with ' },
      {
        type: 'app' as const,
        id: 'app-1',
        name: 'Meal "Planner"',
        slug: 'meal-planner',
      },
    ];

    expect(composerDisplayText(content)).toBe(
      'Match @Meal "Planner"\nthen compare it with @Meal "Planner"',
    );
    expect(composerModelText(content)).toBe(
      'Match @APP{name="Meal \\"Planner\\"" id="app-1" slug="meal-planner"}' +
        '\nthen compare it with ' +
        '@APP{name="Meal \\"Planner\\"" id="app-1" slug="meal-planner"}',
    );
  });

  it('keeps App order while compacting only adjacent text', () => {
    expect(
      compactComposerInput([
        { type: 'text', text: 'one' },
        { type: 'text', text: '' },
        { type: 'text', text: ' two' },
        { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
        { type: 'text', text: ' three' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one two' },
      { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
      { type: 'text', text: ' three' },
    ]);
  });

  it('does not treat an App reference alone as a request', () => {
    const app = {
      type: 'app' as const,
      id: 'app-1',
      name: 'App One',
      slug: 'app-one',
    };
    expect(hasComposerText([app])).toBe(false);
    expect(hasComposerText([{ type: 'text', text: '  ' }, app])).toBe(false);
    expect(hasComposerText([app, { type: 'text', text: 'Update this' }])).toBe(
      true,
    );
  });

  it('bounds App references independently from ordinary text', () => {
    expect(
      composerInputSchema.safeParse(
        Array.from({ length: 32 }, (_, index) => ({
          type: 'app' as const,
          id: `app-${index}`,
          name: `App ${index}`,
          slug: `app-${index}`,
        })),
      ).success,
    ).toBe(true);
    expect(
      composerInputSchema.safeParse(
        Array.from({ length: 33 }, (_, index) => ({
          type: 'app' as const,
          id: `app-${index}`,
          name: `App ${index}`,
          slug: `app-${index}`,
        })),
      ).success,
    ).toBe(false);
  });
});
