export type AppApiPath = {
  id: string;
  prefix: string;
  rest: string;
};

/**
 * Parse the public app runtime API namespaces. The singular namespace is
 * canonical; the plural namespace remains supported for deployed artifacts
 * that contain historical URLs.
 */
export function parseAppApiPath(pathname: string): AppApiPath | null {
  const match = pathname.match(/^\/api\/(app|apps)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    id: match[2],
    prefix: `/api/${match[1]}/${match[2]}`,
    rest: match[3] ?? '',
  };
}
