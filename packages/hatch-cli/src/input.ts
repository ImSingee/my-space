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
  options: { preserveBOM?: boolean } = {},
): Promise<string> {
  if (!path) throw new CliError('input_required', 'Supply --file <path|->.');
  let bytes: Buffer;
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
        const chunkBytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += chunkBytes.byteLength;
        if (size > maxBytes)
          throw new CliError(
            'input_too_large',
            `Input exceeds ${maxBytes} bytes.`,
          );
        chunks.push(chunkBytes);
      }
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'input_cancelled',
        'Input cancelled or timed out.',
        signal.aborted ? 130 : 7,
      );
    }
  } else
    bytes = await readFile(path, { signal }).catch(() => {
      throw new CliError('input_unreadable', 'Cannot read UTF-8 input file.');
    });
  if (bytes.byteLength > maxBytes)
    throw new CliError('input_too_large', `Input exceeds ${maxBytes} bytes.`);
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: options.preserveBOM ?? false,
    }).decode(bytes);
  } catch {
    throw new CliError('invalid_input', 'Input must be valid UTF-8.');
  }
}
