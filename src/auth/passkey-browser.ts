import { getPasskeyOriginError } from './passkey-origin';

export type PasskeyClientError = {
  code?: string;
  message?: string;
};

const CANCELLATION_CODES = new Set([
  'AUTH_CANCELLED',
  'REGISTRATION_CANCELLED',
  'ERROR_CEREMONY_ABORTED',
  // Browsers commonly report a dismissed native prompt as NotAllowedError.
  // SimpleWebAuthn preserves that error under this generic pass-through code.
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
]);

export function browserSupportsPasskeys(appOrigin: string): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    !getPasskeyOriginError(appOrigin, window.location.origin) &&
    typeof window.PublicKeyCredential !== 'undefined'
  );
}

export function isPasskeyCancellation(
  error: PasskeyClientError | null | undefined,
): boolean {
  return Boolean(error?.code && CANCELLATION_CODES.has(error.code));
}

export function passkeyErrorMessage(
  error: PasskeyClientError | null | undefined,
  fallback: string,
): string {
  return error?.message?.trim() || fallback;
}
