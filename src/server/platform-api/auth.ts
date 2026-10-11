/** Credential validity; interactive RPCs additionally require a user session. */
import type { AuthStatus } from '../../../packages/hatch-platform-api/auth';
import { publicApiError } from './errors';
import { auth } from '~auth/server';
import { db } from '~/db';
import {
  verifyRunToken,
  type RunTokenContext,
} from '~server/agent-runner/run-auth';

export type PublicApiContext = {
  request?: Request;
  run: RunTokenContext | null;
  status?: AuthStatus;
  session?: { id: string; expiresAt: Date };
};

export async function authenticatePublicApi(
  request: Request,
): Promise<PublicApiContext> {
  const headers = request.headers;
  // Explicit credentials always win, including malformed/empty credentials.
  if (headers.has('x-api-key')) {
    const result = await auth.api.verifyApiKey({
      body: { key: headers.get('x-api-key') ?? '', configId: 'default' },
    });
    if (!result.valid || !result.key) throw publicApiError('UNAUTHORIZED');
    const owner = await db.query.user.findFirst({
      where: { id: result.key.referenceId },
      columns: { id: true, email: true, name: true },
    });
    if (!owner) throw publicApiError('UNAUTHORIZED');
    return {
      run: null,
      status: {
        authenticated: true,
        credentialType: 'api-key',
        authority: 'platform',
        expiresAt: result.key.expiresAt?.toISOString() ?? null,
        user: owner,
        key: { id: result.key.id, name: result.key.name ?? null },
      },
    };
  }
  if (headers.has('authorization')) {
    const token = /^Bearer\s+(\S+)$/i.exec(
      headers.get('authorization') ?? '',
    )?.[1];
    if (!token) throw publicApiError('UNAUTHORIZED');
    if (token.split('.').length === 3) {
      const { expiresAt, ...run } = await verifyRunToken(token);
      return {
        run,
        status: {
          authenticated: true,
          credentialType: 'run',
          authority: 'platform',
          expiresAt,
          context: run,
        },
      };
    }
    // Do not let the bearer plugin ignore invalid credentials and use a Cookie.
    const bearerOnly = new Headers({ authorization: `Bearer ${token}` });
    const session = await auth.api.getSession({ headers: bearerOnly });
    if (!session) throw publicApiError('UNAUTHORIZED');
    return sessionContext(session);
  }
  const session = await auth.api.getSession({ headers });
  if (!session) throw publicApiError('UNAUTHORIZED');
  return sessionContext(session);
}

function sessionContext(
  value: Awaited<ReturnType<typeof auth.api.getSession>>,
): PublicApiContext {
  if (!value) throw publicApiError('UNAUTHORIZED');
  return {
    run: null,
    session: { id: value.session.id, expiresAt: value.session.expiresAt },
    status: {
      authenticated: true,
      credentialType: 'session',
      authority: 'platform',
      expiresAt: value.session.expiresAt.toISOString(),
      user: {
        id: value.user.id,
        email: value.user.email,
        name: value.user.name,
      },
    },
  };
}
