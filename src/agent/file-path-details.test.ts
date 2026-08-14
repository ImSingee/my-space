import { describe, expect, it } from 'vitest';
import { isFilePathDetails, isFilePathTool } from './file-path-details';

describe('file path details', () => {
  it.each(['list_files', 'read_file', 'write_file', 'edit_file'])(
    'recognizes the %s tool',
    (name) => {
      expect(isFilePathTool(name)).toBe(true);
    },
  );

  it('requires a complete non-empty path pair', () => {
    expect(
      isFilePathDetails({
        relativePath: 'src/app.ts',
        absolutePath: '/runner/work/src/app.ts',
      }),
    ).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { relativePath: 'src/app.ts' },
      { relativePath: '', absolutePath: '/runner/work/src/app.ts' },
    ]) {
      expect(isFilePathDetails(value)).toBe(false);
    }
  });
});
