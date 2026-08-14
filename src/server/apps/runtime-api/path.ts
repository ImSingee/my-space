export type AppApiPath = {
  id: string;
  prefix: string;
  rest: string;
};

/** Parse the public app runtime API namespace. */
export function parseAppApiPath(pathname: string): AppApiPath | null {
  const match = pathname.match(/^\/api\/app\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return {
    id: match[1],
    prefix: `/api/app/${match[1]}`,
    rest: match[2] ?? '',
  };
}
