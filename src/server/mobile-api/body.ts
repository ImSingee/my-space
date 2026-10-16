import { AppError } from '~server/errors';

/** Bound actual bytes, including chunked requests and misleading lengths. */
export async function readMobileBody(request: Request, limit = 16 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) {
    throw new AppError('Payload too large', 413);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new AppError('Payload too large', 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function readMobileJson(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  ) {
    throw new AppError('Expected application/json', 415);
  }
  try {
    return JSON.parse(await readMobileBody(request)) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Invalid JSON', 400);
  }
}
