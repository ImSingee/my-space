import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { isEditFileDetails } from '../edit-file-details';
import {
  DIFF_TRUNCATION_LINE,
  generateDiffString,
  generateEditFileDetails,
  generateUnifiedPatch,
  MAX_EDIT_DETAILS_BYTES,
  MAX_EDIT_DIFF_INPUT_CHARS,
  MAX_EDIT_DIFF_INPUT_LINES,
} from './edit-diff';

describe('edit diff generation', () => {
  it('reports additions, removals, and the first changed line', () => {
    const replacement = generateDiffString(
      'alpha\nbeta\ngamma\n',
      'alpha\nchanged\ngamma\n',
    );
    const addition = generateDiffString('alpha\n', 'alpha\nbeta\n');
    const removal = generateDiffString('alpha\nbeta\n', 'alpha\n');

    expect(replacement).toEqual({
      diff: ' 1 alpha\n-2 beta\n+2 changed\n 3 gamma',
      firstChangedLine: 2,
    });
    expect(addition.diff).toContain('+2 beta');
    expect(addition.firstChangedLine).toBe(2);
    expect(removal.diff).toContain('-2 beta');
    expect(removal.firstChangedLine).toBe(2);
  });

  it('limits unchanged output to four context lines around a change', () => {
    const original =
      Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n') +
      '\n';
    const result = generateDiffString(
      original,
      original.replace('line 8', 'changed 8'),
    );

    expect(result.diff.split('\n')).toEqual([
      '    ...',
      '  4 line 4',
      '  5 line 5',
      '  6 line 6',
      '  7 line 7',
      '- 8 line 8',
      '+ 8 changed 8',
      '  9 line 9',
      ' 10 line 10',
      ' 11 line 11',
      ' 12 line 12',
      '    ...',
    ]);
    expect(result.firstChangedLine).toBe(8);
  });

  it('uses new-file line numbers for context after insertions and deletions', () => {
    expect(generateDiffString('a\nb\n', 'x\na\nb\n').diff).toBe(
      '+1 x\n 2 a\n 3 b',
    );
    expect(generateDiffString('x\na\nb\n', 'a\nb\n').diff).toBe(
      '-1 x\n 1 a\n 2 b',
    );
    expect(generateDiffString('a\nb\nc\n', 'a\nx\nb\nc\n').diff).toBe(
      ' 1 a\n+2 x\n 3 b\n 4 c',
    );
    expect(generateDiffString('a\nx\nb\nc\n', 'a\nb\nc\n').diff).toBe(
      ' 1 a\n-2 x\n 2 b\n 3 c',
    );
  });

  it('marks which side lacks an end-of-file newline', () => {
    expect(generateDiffString('a', 'a\n').diff).toBe(
      '-1 a\n   \\ No newline at end of file\n+1 a',
    );
    expect(generateDiffString('a\n', 'a').diff).toBe(
      '-1 a\n+1 a\n   \\ No newline at end of file',
    );
    expect(generateDiffString('old\nlast', 'new\nlast').diff).toBe(
      '-1 old\n+1 new\n 2 last\n   \\ No newline at end of file',
    );
  });

  it('bounds UTF-8 details and omits rather than corrupting a large patch', () => {
    const oldContent = `TOKEN${'🙂\\'.repeat(20_000)}`;
    const details = generateEditFileDetails({
      path: 'src/large.js',
      replacements: 1,
      oldContent,
      newContent: oldContent.replace('TOKEN', 'DONE'),
    });

    expect(
      Buffer.byteLength(JSON.stringify(details), 'utf8'),
    ).toBeLessThanOrEqual(MAX_EDIT_DETAILS_BYTES);
    expect(details.diffTruncated).toBe(true);
    expect(details.patchOmitted).toBe(true);
    expect(details.patch).toBeUndefined();
    expect(details.diff).toContain(DIFF_TRUNCATION_LINE);
  });

  it('bounds diff computation for broad multi-line replacements', () => {
    const lineCount = MAX_EDIT_DIFF_INPUT_LINES / 2;
    const oldContent = Array.from(
      { length: lineCount },
      (_, index) => `old ${index}\n`,
    ).join('');
    const newContent = Array.from(
      { length: lineCount },
      (_, index) => `new ${index}\n`,
    ).join('');

    const details = generateEditFileDetails({
      path: 'src/large.txt',
      replacements: lineCount,
      oldContent,
      newContent,
    });

    expect(details).toEqual({
      path: 'src/large.txt',
      replacements: lineCount,
      diff: DIFF_TRUNCATION_LINE,
      diffTruncated: true,
      patchOmitted: true,
    });
    expect(isEditFileDetails(details)).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(details), 'utf8'),
    ).toBeLessThanOrEqual(MAX_EDIT_DETAILS_BYTES);
  });

  it('skips diff computation when its input preflight bounds are exceeded', () => {
    const tooManyCharacters = generateDiffString(
      'a'.repeat(MAX_EDIT_DIFF_INPUT_CHARS),
      'b',
    );
    const linesPerSide = MAX_EDIT_DIFF_INPUT_LINES / 2 + 1;
    const oldLines = 'same\n'.repeat(linesPerSide);
    const tooManyLines = generateDiffString(
      oldLines,
      oldLines.replace('same', 'changed'),
    );

    expect(tooManyCharacters).toEqual({
      diff: DIFF_TRUNCATION_LINE,
      truncated: true,
    });
    expect(tooManyLines).toEqual({
      diff: DIFF_TRUNCATION_LINE,
      truncated: true,
    });
  });

  it('normalizes CRLF in display diffs and unified patches', () => {
    const oldContent = 'one\r\ntwo\r\n';
    const newContent = 'one\r\nthree\r\n';
    const display = generateDiffString(oldContent, newContent);
    const patch = generateUnifiedPatch('src/app.ts', oldContent, newContent);

    expect(display.diff).toBe(' 1 one\n-2 two\n+2 three');
    expect(display.diff).not.toContain('\r');
    expect(patch).toBeDefined();
    expect(patch).toContain(
      '--- src/app.ts\n+++ src/app.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three',
    );
    expect(patch).not.toContain('\r');
  });
});
