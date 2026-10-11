import { readFile } from 'node:fs/promises';
import { addAbortSignal } from 'node:stream';
import { CliError } from './error';
export async function readInput(
  path: string,
  signal: AbortSignal,
  maxBytes = 16384,
): Promise<Record<string, unknown>> {
  const contents = await readTextInput(path, signal, maxBytes);
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CliError('invalid_input', 'Input must be a JSON object.');
  }
}
export async function readTextInput(
  path: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  if (!path) throw new CliError('input_required', 'Supply --file <path|->.');
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
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of process.stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.byteLength;
        if (size > maxBytes)
          throw new CliError(
            'input_too_large',
            `Input exceeds ${maxBytes} bytes.`,
          );
        chunks.push(bytes);
      }
      contents = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'input_cancelled',
        'Input cancelled or timed out.',
        signal.aborted ? 130 : 7,
      );
    }
  } else
    contents = await readFile(path, { signal })
      .then((bytes) => {
        if (bytes.byteLength > maxBytes)
          throw new CliError(
            'input_too_large',
            `Input exceeds ${maxBytes} bytes.`,
          );
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      })
      .catch((error) => {
        if (error instanceof CliError) throw error;
        throw new CliError('input_unreadable', 'Cannot read UTF-8 input file.');
      });
  if (Buffer.byteLength(contents) > maxBytes)
    throw new CliError('input_too_large', `Input exceeds ${maxBytes} bytes.`);
  return contents;
}
