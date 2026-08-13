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

const { handle } = await import('./$appSlug/embed/$.ts');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.serveAppAppFile.mockResolvedValue(new Response('app file'));
});

describe('embedded app route', () => {
  it('resolves the public path segment strictly as a slug', async () => {
    mocks.appIdForSlug.mockResolvedValue('01immutableid');

    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/embed/assets/app.js',
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
      request: new Request(
        'https://hatch.test/app/01immutableid/embed/index.html',
      ),
    });

    expect(response.status).toBe(404);
    expect(mocks.appIdForSlug).toHaveBeenCalledWith('01immutableid');
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });

  it('keeps authentication ahead of app lookup', async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/embed/index.html',
      ),
    });

    expect(response.status).toBe(401);
    expect(mocks.appIdForSlug).not.toHaveBeenCalled();
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });

  it('redirects the embed root to its canonical trailing-slash URL', async () => {
    mocks.appIdForSlug.mockResolvedValue('01immutableid');

    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/embed?view=compact',
      ),
    });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(
      'https://hatch.test/app/human-readable-slug/embed/?view=compact',
    );
    expect(mocks.appIdForSlug).toHaveBeenCalledWith('human-readable-slug');
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });

  it('serves the index from the canonical embed root', async () => {
    mocks.appIdForSlug.mockResolvedValue('01immutableid');

    const response = await handle({
      request: new Request('https://hatch.test/app/human-readable-slug/embed/'),
    });

    expect(response.status).toBe(200);
    expect(mocks.serveAppAppFile).toHaveBeenCalledWith('01immutableid', '');
  });

  it('returns 404 for the former direct app asset path', async () => {
    const response = await handle({
      request: new Request(
        'https://hatch.test/app/human-readable-slug/assets/app.js',
      ),
    });

    expect(response.status).toBe(404);
    expect(mocks.appIdForSlug).not.toHaveBeenCalled();
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the slug does not resolve', async () => {
    mocks.appIdForSlug.mockResolvedValue(null);

    const response = await handle({
      request: new Request('https://hatch.test/app/missing/embed/'),
    });

    expect(response.status).toBe(404);
    expect(mocks.appIdForSlug).toHaveBeenCalledWith('missing');
    expect(mocks.serveAppAppFile).not.toHaveBeenCalled();
  });
});
