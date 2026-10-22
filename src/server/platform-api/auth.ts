/** Platform adapter; interactive RPCs still require context.session. */
import {
  authenticateCredential,
  CredentialError,
  type CredentialContext,
} from '~server/auth/credentials';
import { publicApiError } from './errors';

export type PublicApiContext = CredentialContext & { request?: Request };

export async function authenticatePublicApi(
  request: Request,
): Promise<PublicApiContext> {
  try {
    return await authenticateCredential(request);
  } catch (error) {
    if (error instanceof CredentialError) throw publicApiError('UNAUTHORIZED');
    throw error;
  }
}
