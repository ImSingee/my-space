import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';

// SimpleWebAuthn 13's startAuthentication does not accept the caller's signal,
// and its conditional capability check yields before creating its own signal.
// Own the native call so cancellation covers every phase, including that gap.
export async function authenticatePasskey(
  options: PublicKeyCredentialRequestOptionsJSON,
  conditional: boolean,
  signal: AbortSignal,
): Promise<AuthenticationResponseJSON> {
  const credential = (await navigator.credentials.get({
    signal,
    ...(conditional ? { mediation: 'conditional' as const } : {}),
    publicKey: {
      ...options,
      challenge: base64URLStringToBuffer(options.challenge),
      allowCredentials: conditional
        ? []
        : options.allowCredentials?.length
          ? (options.allowCredentials.map((entry) => ({
              ...entry,
              id: base64URLStringToBuffer(entry.id),
            })) as PublicKeyCredentialDescriptor[])
          : undefined,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Authentication was not completed.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: 'public-key',
    response: {
      authenticatorData: bufferToBase64URLString(response.authenticatorData),
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      signature: bufferToBase64URLString(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64URLString(response.userHandle)
        : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment:
      credential.authenticatorAttachment === 'platform' ||
      credential.authenticatorAttachment === 'cross-platform'
        ? credential.authenticatorAttachment
        : undefined,
  };
}
