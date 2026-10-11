import { readFile } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';
import { CliError } from './error';
export async function readInput(
  path: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!path)
    throw new CliError(
      'input_required',
      'Supply --file <path|-> containing JSON.',
    );
  let contents: string;
  if (path === '-') {
    if (process.stdin.isTTY)
      throw new CliError(
        'stdin_required',
        'Pipe JSON or redirect a file for --file -.',
      );
    addAbortSignal(
      AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      process.stdin,
    );
    process.stdin.setEncoding('utf8');
    contents = '';
    try {
      for await (const chunk of process.stdin) {
        contents += chunk;
        if (contents.length > 16384)
          throw new CliError('input_too_large', 'Input exceeds 16 KiB.');
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'input_cancelled',
        'Input cancelled or timed out.',
        signal.aborted ? 130 : 7,
      );
    }
  } else
    contents = await readFile(path, 'utf8').catch(() => {
      throw new CliError('input_unreadable', 'Cannot read JSON input file.');
    });
  if (Buffer.byteLength(contents) > 16384)
    throw new CliError('input_too_large', 'Input exceeds 16 KiB.');
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CliError('invalid_input', 'Input must be a JSON object.');
  }
}
