import { describe, expect, it } from 'vitest';
import { splitModelValue } from './model-value';

describe('splitModelValue', () => {
  it('preserves colons inside model ids', () => {
    expect(splitModelValue('provider:model:version:0')).toEqual({
      providerId: 'provider',
      modelId: 'model:version:0',
    });
  });
});
