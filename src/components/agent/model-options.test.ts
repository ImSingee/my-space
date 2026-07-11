import { describe, expect, it } from 'vitest';
import { resolveEffectiveModel, splitModelValue } from './model-value';

describe('resolveEffectiveModel', () => {
  const available = new Set(['provider-a:model-a', 'provider-b:model-b']);

  it('prefers the current manual selection', () => {
    expect(
      resolveEffectiveModel(
        'provider-b:model-b',
        'provider-a:model-a',
        available,
        'provider-a:model-a',
      ),
    ).toBe('provider-b:model-b');
  });

  it('uses a still-available session model before the first option', () => {
    expect(
      resolveEffectiveModel(
        null,
        'provider-b:model-b',
        available,
        'provider-a:model-a',
      ),
    ).toBe('provider-b:model-b');
  });

  it('ignores unavailable selections and session models', () => {
    expect(
      resolveEffectiveModel(
        'removed:model',
        'disabled:model',
        available,
        'provider-a:model-a',
      ),
    ).toBe('provider-a:model-a');
    expect(
      resolveEffectiveModel('removed:model', 'disabled:model', new Set(), null),
    ).toBeNull();
  });
});

describe('splitModelValue', () => {
  it('preserves colons inside model ids', () => {
    expect(splitModelValue('provider:model:version:0')).toEqual({
      providerId: 'provider',
      modelId: 'model:version:0',
    });
  });
});
