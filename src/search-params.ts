import { parseSearchWith, stringifySearchWith } from '@tanstack/react-router';

/**
 * JSON search values, accepted only when they survive a round trip.
 *
 * The router's default parser turns text such as `23456E78` (a valid device
 * user code) or `1.50` into numbers that serialize differently, and the router
 * then rewrites the address bar to that form. Such values stay the original
 * string instead.
 */
function parseValue(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed === 'number' && JSON.stringify(parsed) !== value)
    throw new Error('Not a lossless number');
  return parsed;
}

export const parseSearch = parseSearchWith(parseValue);
export const stringifySearch = stringifySearchWith(JSON.stringify, parseValue);
