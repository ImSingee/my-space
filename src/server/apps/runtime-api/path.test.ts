import { describe, expect, it } from 'vitest';
import { parseAppApiPath } from './path';

describe('public app API path parser', () => {
  it.each([
    [
      '/api/app/01example/rpc/todos.list',
      {
        id: '01example',
        prefix: '/api/app/01example',
        rest: '/rpc/todos.list',
      },
    ],
    [
      '/api/apps/01example/data/events',
      {
        id: '01example',
        prefix: '/api/apps/01example',
        rest: '/data/events',
      },
    ],
  ])('parses the supported namespace in %s', (pathname, expected) => {
    expect(parseAppApiPath(pathname)).toEqual(expected);
  });

  it.each([
    '/api/application/01example/rpc',
    '/api/appss/01example/rpc',
    '/api/app//rpc',
    '/api/app',
    '/internal/api/apps/01example/rpc',
  ])('rejects an unsupported namespace or missing id in %s', (pathname) => {
    expect(parseAppApiPath(pathname)).toBeNull();
  });
});
