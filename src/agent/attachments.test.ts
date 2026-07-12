import { describe, expect, it } from 'vitest';
import {
  formatAttachmentPrompt,
  safeAttachmentName,
  stripAttachmentPrompt,
} from './attachments';

const literal =
  'Explain this XML:\n<hatch_attachments>literal</hatch_attachments>';

describe('attachment prompt context', () => {
  it('preserves literal attachment tags in raw user text', () => {
    expect(formatAttachmentPrompt(literal, [])).toBe(literal);
  });

  it('removes only the generated context from a persisted message', () => {
    const formatted = formatAttachmentPrompt(literal, [
      {
        id: 'file-a',
        name: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 2,
      },
    ]);

    const attachments = [
      {
        id: 'file-a',
        name: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 2,
      },
    ];
    expect(stripAttachmentPrompt(formatted, attachments)).toBe(literal);
  });

  it('preserves a user-authored block that matches the internal wording', () => {
    const attachments = [
      {
        id: 'file-a',
        name: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 2,
      },
    ];
    const userBlock = formatAttachmentPrompt('', [
      {
        id: 'literal',
        name: 'literal.bin',
        mimeType: 'text/plain',
        size: 1,
      },
    ]);
    const raw = `Explain this literal block:\n${userBlock}`;
    const formatted = formatAttachmentPrompt(raw, attachments);

    expect(stripAttachmentPrompt(formatted, attachments)).toBe(raw);
  });
});

describe('safe attachment names', () => {
  it('caps NFKC-expanded names at the Linux UTF-8 filename limit', () => {
    const safe = safeAttachmentName('\uFDFA'.repeat(20));

    expect(new TextEncoder().encode(safe).byteLength).toBeLessThanOrEqual(255);
  });

  it('keeps complete Unicode code points and preserves the extension', () => {
    const letter = '\u{10400}';
    const safe = safeAttachmentName(`${letter.repeat(100)}.json`);

    expect(new TextEncoder().encode(safe).byteLength).toBeLessThanOrEqual(255);
    expect(safe.endsWith('.json')).toBe(true);
    expect(safe.slice(0, -'.json'.length)).toBe(letter.repeat(62));
  });
});
