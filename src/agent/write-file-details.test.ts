import { describe, expect, it } from 'vitest';
import { isWriteFileDetails } from './write-file-details';

describe('isWriteFileDetails', () => {
  it('accepts an object with a string path', () => {
    expect(isWriteFileDetails({ path: 'src/app.ts' })).toBe(true);
  });

  it.each([null, [], {}, { path: 42 }])(
    'rejects invalid write details: %j',
    (value) => {
      expect(isWriteFileDetails(value)).toBe(false);
    },
  );
});
