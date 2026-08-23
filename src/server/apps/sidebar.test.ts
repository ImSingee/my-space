import { describe, expect, it } from 'vitest';
import { MAX_ENTRY_HASH_LEN, normalizeEntryHash } from './sidebar';

describe('normalizeEntryHash', () => {
  it('returns null for empty/whitespace input', () => {
    expect(normalizeEntryHash('')).toBeNull();
    expect(normalizeEntryHash('   ')).toBeNull();
    expect(normalizeEntryHash('#')).toBeNull();
    expect(normalizeEntryHash('  #  ')).toBeNull();
  });

  it('strips a single leading hash and trims', () => {
    expect(normalizeEntryHash('#/settings')).toBe('/settings');
    expect(normalizeEntryHash('  /usage  ')).toBe('/usage');
    expect(normalizeEntryHash('#  /usage')).toBe('/usage');
  });

  it('drops control characters', () => {
    expect(normalizeEntryHash('/a\u0000b\u0007c')).toBe('/abc');
    expect(normalizeEntryHash('/tab\there')).toBe('/tabhere');
  });

  it('caps length at MAX_ENTRY_HASH_LEN', () => {
    const long = `/${'a'.repeat(MAX_ENTRY_HASH_LEN + 50)}`;
    const result = normalizeEntryHash(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(MAX_ENTRY_HASH_LEN);
  });
});
