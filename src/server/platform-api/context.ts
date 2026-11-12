import { createContextKey } from '@connectrpc/connect';
import type { PublicApiContext } from './auth';

/** Authenticated caller of the current public API request. */
export const publicApiContext = createContextKey<PublicApiContext>({
  run: null,
});
