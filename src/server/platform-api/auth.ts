/** Credential validity only: every authenticated caller has full public access. */
import { ORPCError } from '@orpc/server';
import { auth } from '~auth/server';
import { db } from '~/db';
import {
  verifyRunToken,
  type RunTokenContext,
} from '~server/agent-runner/run-auth';

export type PublicApiContext = { run: RunTokenContext | null };

export async function authenticatePublicApi(
  request: Request,
): Promise<PublicApiContext> {
  const headers = request.headers;
  // Explicit credentials always win, including malformed/empty credentials.
  if (headers.has('x-api-key')) {
    const result = await auth.api.verifyApiKey({
      body: { key: headers.get('x-api-key') ?? '', configId: 'default' },
    });
    if (!result.valid || !result.key) throw new ORPCError('UNAUTHORIZED');
    const owner = await db.query.user.findFirst({
      where: { id: result.key.referenceId },
      columns: { id: true },
    });
    if (!owner) throw new ORPCError('UNAUTHORIZED');
    return { run: null };
  }
  if (headers.has('authorization')) {
    const token = /^Bearer\s+(\S+)$/i.exec(
      headers.get('authorization') ?? '',
    )?.[1];
    if (!token) throw new ORPCError('UNAUTHORIZED');
    if (token.split('.').length === 3)
      return { run: await verifyRunToken(token) };
    // Do not let the bearer plugin ignore invalid credentials and use a Cookie.
    const bearerOnly = new Headers({ authorization: `Bearer ${token}` });
    const session = await auth.api.getSession({ headers: bearerOnly });
    if (!session) throw new ORPCError('UNAUTHORIZED');
    return { run: null };
  }
  const session = await auth.api.getSession({ headers });
  if (!session) throw new ORPCError('UNAUTHORIZED');
  return { run: null };
}
