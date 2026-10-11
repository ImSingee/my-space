import { createFileRoute } from '@tanstack/react-router';
import { passkeyRelatedOriginsResponse } from '~server/passkey-related-origins';

export const Route = createFileRoute('/.well-known/webauthn')({
  server: {
    handlers: { GET: () => passkeyRelatedOriginsResponse() },
  },
});
