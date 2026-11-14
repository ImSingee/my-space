/**
 * Decodes ASCII percent-escapes, nested up to a few levels. Paths, slugs and
 * tickets use ASCII, so this reveals them however they are encoded, while an
 * unrelated malformed escape or invalid UTF-8 cannot hide them. Excessive
 * nesting is ambiguous and returns null.
 */
export function decodeUrlAscii(value: string): string | null {
  let text = value;
  for (let depth = 0; depth < 4; depth++) {
    const decoded = text.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (decoded === text) return text;
    text = decoded;
  }
  return /%[0-7][0-9a-f]/i.test(text) ? null : text;
}
