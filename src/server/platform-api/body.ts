import { AppError } from '~server/errors';

/** Bound actual bytes, including chunked requests and misleading lengths. */
export async function readBoundedText(request: Request, limit = 16 * 1024) {
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
