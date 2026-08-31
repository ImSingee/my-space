import { describe, expect, it } from 'vitest';
import {
  compactComposerInput,
  composerDisplayText,
  composerInputSchema,
  composerModelText,
  hasComposerReference,
  hasComposerText,
} from './composer-content';

describe('Agent Composer content', () => {
  it('serializes resource references differently for the UI and model', () => {
    const content = [
      { type: 'text' as const, text: 'Match ' },
      {
        type: 'app' as const,
        id: 'app-1',
        name: 'Meal "Planner"',
        slug: 'meal-planner',
      },
      { type: 'text' as const, text: '\nthen run ' },
      {
        type: 'workflow' as const,
        id: 'workflow-1',
        name: 'Nightly "Digest"',
      },
    ];

    expect(composerDisplayText(content)).toBe(
      'Match @Meal "Planner"\nthen run @Nightly "Digest"',
    );
    expect(composerModelText(content)).toBe(
      'Match @APP{name="Meal \\"Planner\\"" id="app-1" slug="meal-planner"}' +
        '\nthen run ' +
        '@WORKFLOW{name="Nightly \\"Digest\\"" id="workflow-1"}',
    );
  });

  it('keeps reference order while compacting only adjacent text', () => {
    expect(
      compactComposerInput([
        { type: 'text', text: 'one' },
        { type: 'text', text: '' },
        { type: 'text', text: ' two' },
        { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
        { type: 'text', text: ' three' },
        { type: 'workflow', id: 'workflow-1', name: 'Workflow One' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one two' },
      { type: 'app', id: 'app-1', name: 'App One', slug: 'app-one' },
      { type: 'text', text: ' three' },
      { type: 'workflow', id: 'workflow-1', name: 'Workflow One' },
    ]);
  });

  it('does not treat resource references alone as a request', () => {
    const app = {
      type: 'app' as const,
      id: 'app-1',
      name: 'App One',
      slug: 'app-one',
    };
    const workflow = {
      type: 'workflow' as const,
      id: 'workflow-1',
      name: 'Workflow One',
    };
    expect(hasComposerReference([app, workflow])).toBe(true);
    expect(hasComposerText([app, workflow])).toBe(false);
    expect(hasComposerText([{ type: 'text', text: '  ' }, app, workflow])).toBe(
      false,
    );
    expect(
      hasComposerText([workflow, { type: 'text', text: 'Update this' }]),
    ).toBe(true);
  });

  it('bounds App and Workflow references together', () => {
    const references = Array.from({ length: 32 }, (_, index) =>
      index % 2 === 0
        ? {
            type: 'app' as const,
            id: `app-${index}`,
            name: `App ${index}`,
            slug: `app-${index}`,
          }
        : {
            type: 'workflow' as const,
            id: `workflow-${index}`,
            name: `Workflow ${index}`,
          },
    );
    expect(composerInputSchema.safeParse(references).success).toBe(true);
    expect(
      composerInputSchema.safeParse(
        references.concat({
          type: 'workflow',
          id: 'workflow-over-limit',
          name: 'Workflow over limit',
        }),
      ).success,
    ).toBe(false);
  });
});
