import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInternalHttpHandler } from './internal-server';

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
