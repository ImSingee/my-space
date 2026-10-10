import { expect, test } from 'vitest';
import { parseSearch, stringifySearch } from './search-params';

test('values that JSON would read as a different number keep their text', () => {
  // A valid device user code that JSON.parse reads as 2.3456e+82.
  const search = parseSearch('?user_code=23456E78&price=1.50');
  expect(search).toEqual({ user_code: '23456E78', price: '1.50' });
  expect(stringifySearch(search)).toBe('?user_code=23456E78&price=1.50');
});

test('lossless JSON values still round-trip with their types', () => {
  const search = parseSearch('?page=2&flag=true&code=%2223456789%22');
  expect(search).toEqual({ page: 2, flag: true, code: '23456789' });
  expect(parseSearch(stringifySearch(search))).toEqual(search);
});
