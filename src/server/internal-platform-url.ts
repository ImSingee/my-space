const DEFAULT_PLATFORM_PORT = '3700';

/** Build an absolute URL for calls that stay inside the platform process. */
export function internalPlatformUrl(pathname: string): string {
  const port = process.env.PORT ?? DEFAULT_PLATFORM_PORT;
  return new URL(pathname, `http://127.0.0.1:${port}`).toString();
}
