/** Diff generation shared by `edit_file` and its tests. */
import { Buffer } from 'node:buffer';
import * as Diff from 'diff';
import type { EditFileDetails } from '../edit-file-details';

const DEFAULT_CONTEXT_LINES = 4;
export const MAX_EDIT_DETAILS_BYTES = 32 * 1024;
export const MAX_EDIT_DISPLAY_DIFF_BYTES = 16 * 1024;
export const MAX_EDIT_DIFF_INPUT_CHARS = 1024 * 1024;
export const MAX_EDIT_DIFF_INPUT_LINES = 20_000;
export const MAX_EDIT_DIFF_EDIT_LENGTH = 512;
export const DIFF_TRUNCATION_LINE = ' … (diff truncated)';

type DisplayDiffLine = { text: string; hasNewline: boolean };

function splitDiffLines(value: string): DisplayDiffLine[] {
  if (!value) return [];
  const hasTrailingNewline = value.endsWith('\n');
  const lines = value.split('\n');
  if (hasTrailingNewline) lines.pop();
  return lines.map((text, index) => ({
    text,
    hasNewline: index < lines.length - 1 || hasTrailingNewline,
  }));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function createBoundedOutput(maxBytes: number) {
  const lines: string[] = [];
  const markerBytes = utf8Bytes(DIFF_TRUNCATION_LINE);
  const contentBudget = Math.max(0, maxBytes - markerBytes - 1);
  let contentBytes = 0;
  let truncated = false;

  const append = (line: string): boolean => {
    const separatorBytes = lines.length > 0 ? 1 : 0;
    const available = contentBudget - contentBytes - separatorBytes;
    if (utf8Bytes(line) <= available) {
      lines.push(line);
      contentBytes += separatorBytes + utf8Bytes(line);
      return true;
    }
    const clipped = truncateUtf8(line, Math.max(0, available));
    if (clipped) {
      lines.push(clipped);
      contentBytes += separatorBytes + utf8Bytes(clipped);
    }
    truncated = true;
    return false;
  };

  return {
    append,
    get truncated() {
      return truncated;
    },
    toString() {
      return [...lines, ...(truncated ? [DIFF_TRUNCATION_LINE] : [])].join(
        '\n',
      );
    },
  };
}

/** Normalize line endings only for diff output; file editing remains byte-safe. */
function normalizeToLf(content: string): string {
  return content.replaceAll('\r\n', '\n');
}

/**
 * Keep jsdiff's synchronous tokenization and common-line scans bounded before
 * entering its edit graph. Line tokens are counted across both file versions.
 */
function exceedsDiffInputBounds(
  oldContent: string,
  newContent: string,
): boolean {
  if (oldContent.length + newContent.length > MAX_EDIT_DIFF_INPUT_CHARS) {
    return true;
  }

  let lineTokens = 0;
  for (const content of [oldContent, newContent]) {
    if (!content) continue;
    if (!content.endsWith('\n')) lineTokens += 1;
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) !== 10) continue;
      lineTokens += 1;
      if (lineTokens > MAX_EDIT_DIFF_INPUT_LINES) return true;
    }
  }
  return lineTokens > MAX_EDIT_DIFF_INPUT_LINES;
}

function truncatedDisplayDiff(): {
  diff: string;
  truncated: true;
} {
  return { diff: DIFF_TRUNCATION_LINE, truncated: true };
}

/** Generate a standard unified patch with the same file on both sides. */
export function generateUnifiedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = DEFAULT_CONTEXT_LINES,
): string | undefined {
  if (exceedsDiffInputBounds(oldContent, newContent)) return undefined;
  return Diff.createTwoFilesPatch(
    filePath,
    filePath,
    normalizeToLf(oldContent),
    normalizeToLf(newContent),
    undefined,
    undefined,
    {
      context: contextLines,
      headerOptions: Diff.FILE_HEADERS_ONLY,
      maxEditLength: MAX_EDIT_DIFF_EDIT_LENGTH,
    },
  );
}

/**
 * Generate a compact, line-numbered diff for display in the chat timeline.
 * Unchanged stretches are reduced to `contextLines` around each change.
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = DEFAULT_CONTEXT_LINES,
  maxOutputBytes = MAX_EDIT_DISPLAY_DIFF_BYTES,
): { diff: string; firstChangedLine?: number; truncated?: boolean } {
  if (exceedsDiffInputBounds(oldContent, newContent)) {
    return truncatedDisplayDiff();
  }
  const oldText = normalizeToLf(oldContent);
  const newText = normalizeToLf(newContent);
  const parts = Diff.diffLines(oldText, newText, {
    maxEditLength: MAX_EDIT_DIFF_EDIT_LENGTH,
  });
  if (!parts) return truncatedDisplayDiff();
  const output = createBoundedOutput(maxOutputBytes);
  const maxLineNumber = Math.max(
    oldText.split('\n').length,
    newText.split('\n').length,
  );
  const lineNumberWidth = String(maxLineNumber).length;
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  partsLoop: for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const lines = splitDiffLines(part.value);

    const appendLine = (line: string, hasNewline: boolean): boolean => {
      if (!output.append(line)) return false;
      if (hasNewline) return true;
      return output.append(
        ` ${''.padStart(lineNumberWidth, ' ')} \\ No newline at end of file`,
      );
    };

    if (part.added || part.removed) {
      firstChangedLine ??= newLineNumber;
      for (const line of lines) {
        if (part.added) {
          const number = String(newLineNumber).padStart(lineNumberWidth, ' ');
          if (!appendLine(`+${number} ${line.text}`, line.hasNewline)) {
            break partsLoop;
          }
          newLineNumber += 1;
        } else {
          const number = String(oldLineNumber).padStart(lineNumberWidth, ' ');
          if (!appendLine(`-${number} ${line.text}`, line.hasNewline)) {
            break partsLoop;
          }
          oldLineNumber += 1;
        }
      }
      lastWasChange = true;
      continue;
    }

    const nextPart = parts[index + 1];
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = Boolean(nextPart?.added || nextPart?.removed);

    const appendContext = (context: DisplayDiffLine[]): boolean => {
      for (const line of context) {
        const number = String(newLineNumber).padStart(lineNumberWidth, ' ');
        if (!appendLine(` ${number} ${line.text}`, line.hasNewline)) {
          return false;
        }
        oldLineNumber += 1;
        newLineNumber += 1;
      }
      return true;
    };
    const appendEllipsis = (skippedLines: number): boolean => {
      if (skippedLines <= 0) return true;
      if (!output.append(` ${''.padStart(lineNumberWidth, ' ')} ...`)) {
        return false;
      }
      oldLineNumber += skippedLines;
      newLineNumber += skippedLines;
      return true;
    };

    if (hasLeadingChange && hasTrailingChange) {
      if (lines.length <= contextLines * 2) {
        if (!appendContext(lines)) break;
      } else {
        if (
          !appendContext(lines.slice(0, contextLines)) ||
          !appendEllipsis(lines.length - contextLines * 2) ||
          !appendContext(lines.slice(-contextLines))
        ) {
          break;
        }
      }
    } else if (hasLeadingChange) {
      if (
        !appendContext(lines.slice(0, contextLines)) ||
        !appendEllipsis(Math.max(0, lines.length - contextLines))
      ) {
        break;
      }
    } else if (hasTrailingChange) {
      const skippedLines = Math.max(0, lines.length - contextLines);
      if (
        !appendEllipsis(skippedLines) ||
        !appendContext(lines.slice(skippedLines))
      ) {
        break;
      }
    } else {
      oldLineNumber += lines.length;
      newLineNumber += lines.length;
    }
    lastWasChange = false;
  }

  return {
    diff: output.toString(),
    firstChangedLine,
    ...(output.truncated ? { truncated: true } : {}),
  };
}

function detailsBytes(details: EditFileDetails): number {
  return utf8Bytes(JSON.stringify(details));
}

function stripTruncationLine(diff: string): string {
  if (diff === DIFF_TRUNCATION_LINE) return '';
  const suffix = `\n${DIFF_TRUNCATION_LINE}`;
  return diff.endsWith(suffix) ? diff.slice(0, -suffix.length) : diff;
}

function truncateDetailsDiff(details: EditFileDetails): EditFileDetails {
  const source = stripTruncationLine(details.diff);
  const build = (prefixLength: number): EditFileDetails => {
    let prefix = source.slice(0, prefixLength);
    if (prefix && !prefix.endsWith('\n')) prefix += '\n';
    return {
      ...details,
      diff: `${prefix}${DIFF_TRUNCATION_LINE}`,
      diffTruncated: true,
      patchOmitted: true,
    };
  };
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (detailsBytes(build(middle)) <= MAX_EDIT_DETAILS_BYTES) low = middle;
    else high = middle - 1;
  }
  return build(low);
}

export function generateEditFileDetails({
  path,
  replacements,
  oldContent,
  newContent,
}: {
  path: string;
  replacements: number;
  oldContent: string;
  newContent: string;
}): EditFileDetails {
  const display = generateDiffString(oldContent, newContent);
  const base: EditFileDetails = {
    path,
    replacements,
    diff: display.diff,
    ...(display.firstChangedLine === undefined
      ? {}
      : { firstChangedLine: display.firstChangedLine }),
    ...(display.truncated ? { diffTruncated: true } : {}),
  };

  if (!display.truncated) {
    const patch = generateUnifiedPatch(path, oldContent, newContent);
    if (patch !== undefined) {
      const complete = { ...base, patch };
      if (detailsBytes(complete) <= MAX_EDIT_DETAILS_BYTES) return complete;
    }
  }

  const withoutPatch: EditFileDetails = { ...base, patchOmitted: true };
  return detailsBytes(withoutPatch) <= MAX_EDIT_DETAILS_BYTES
    ? withoutPatch
    : truncateDetailsDiff(withoutPatch);
}
