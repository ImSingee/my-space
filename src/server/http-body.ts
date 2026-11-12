/**
 * Read a request body as UTF-8 text, returning null once `max` bytes are
 * exceeded (by the declared Content-Length or the streamed bytes) so callers
 * can reject oversized payloads instead of buffering them whole.
 */
export async function readCappedText(
  request: Request,
  max: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = request.body;
  if (!body) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > max ? null : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
