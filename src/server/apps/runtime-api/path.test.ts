import { describe, expect, it } from 'vitest';
import { parseAppApiPath } from './path';

describe('public app API path parser', () => {
  it('parses the singular namespace', () => {
    expect(parseAppApiPath('/api/app/01example/rpc/todos.list')).toEqual({
      id: '01example',
      prefix: '/api/app/01example',
      rest: '/rpc/todos.list',
    });
  });

  it.each([
    '/api/apps/01example/rpc',
    '/api/application/01example/rpc',
    '/api/appss/01example/rpc',
    '/api/app//rpc',
    '/api/app',
    '/internal/api/apps/01example/rpc',
  ])('rejects an unsupported namespace or missing id in %s', (pathname) => {
    expect(parseAppApiPath(pathname)).toBeNull();
  });
});
