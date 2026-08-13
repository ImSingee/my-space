import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  appIdForSlug: vi.fn<(slug: string) => Promise<string | null>>(),
  serveAppAppFile: vi.fn<(id: string, path: string) => Promise<Response>>(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~server/apps/access', () => ({
  appIdForSlug: mocks.appIdForSlug,
}));
vi.mock('~server/apps/serve-app', () => ({
  serveAppAppFile: mocks.serveAppAppFile,
}));

const { handle } = await import('./$appSlug/$.ts');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.serveAppAppFile.mockResolvedValue(new Response('app file'));
});

describe('direct app route', () => {
  it('resolves the public path segment strictly as a slug', async () => {
    mocks.appIdForSlug.mockResolvedValue('01immutableid');

    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/assets/app.js',
      ),
    });

    expect(response.status).toBe(200);
    expect(mocks.appIdForSlug).toHaveBeenCalledWith('human-readable-slug');
    expect(mocks.serveAppAppFile).toHaveBeenCalledWith(
      '01immutableid',
      'assets/app.js',
    );
  });

  it('returns 404 when the URL segment is an id rather than a slug', async () => {
    mocks.appIdForSlug.mockResolvedValue(null);

    const response = await handle({
      request: new Request('https://hatch.test/app/01immutableid/index.html'),
    });

    expect(response.status).toBe(404);
    expect(mocks.appIdForSlug).toHaveBeenCalledWith('01immutableid');
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });

  it('keeps authentication ahead of app lookup', async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/index.html',
      ),
    });

    expect(response.status).toBe(401);
    expect(mocks.appIdForSlug).not.toHaveBeenCalled();
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });
});
