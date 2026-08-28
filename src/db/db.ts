import { drizzle } from 'drizzle-orm/postgres-js';

import { developmentQueryLogger } from './parameter-redacting-logger';
import { relations } from './relations';
import * as schema from './schema';
import { isSpaShellPrerendering } from '~env';

export { schema };

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !isSpaShellPrerendering()) {
  throw new Error('environment variable DATABASE_URL is not set');
}

export const db = drizzle({
  // TanStack Start boots the built server to prerender the static SPA shell.
  // Startup side effects are disabled in that process, so this inert URL is
  // parsed but never connected to. Real runtime processes still require the
  // explicit DATABASE_URL checked above.
  connection: databaseUrl ?? 'postgres://prerender@127.0.0.1:1/hatch-prerender',
  relations,
  logger:
    process.env.NODE_ENV === 'development' ? developmentQueryLogger : false,
});

export type DB = typeof db;
export type TX = Parameters<Parameters<DB['transaction']>[0]>[0];
