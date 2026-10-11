import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInternalHttpHandler } from './internal-server';

// Unauthorized requests are rejected before any database or auth access.
vi.mock('~/db', async () => ({
  db: {},
  schema: await import('~/db/schema'),
}));
vi.mock('~auth/server', () => ({ auth: {} }));

let server: http.Server;
let origin: string;

beforeAll(async () => {
  server = http.createServer(createInternalHttpHandler('runner-secret'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Internal server test did not bind TCP.');
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('internal server authentication', () => {
  it.each(['/internal/api/apps', '/internal/api/workflows'])(
    'does not expose %s anonymously',
    async (pathname) => {
      const response = await fetch(`${origin}${pathname}`);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Unauthorized',
      });
    },
  );
});
