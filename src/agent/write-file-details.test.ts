import { describe, expect, it } from 'vitest';
import { isWriteFileDetails } from './write-file-details';

describe('isWriteFileDetails', () => {
  it('accepts an object with a string path', () => {
    expect(isWriteFileDetails({ path: 'src/app.ts' })).toBe(true);
    expect(
      isWriteFileDetails({
        path: 'src/app.ts',
        relativePath: 'src/app.ts',
        absolutePath: '/runner/work/src/app.ts',
      }),
    ).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { path: 42 },
    { path: 'src/app.ts', relativePath: 'src/app.ts' },
    { path: 'src/app.ts', absolutePath: '/runner/work/src/app.ts' },
    { path: 'src/app.ts', relativePath: '', absolutePath: '' },
  ])('rejects invalid write details: %j', (value) => {
    expect(isWriteFileDetails(value)).toBe(false);
  });
});
