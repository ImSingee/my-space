import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  // baseURL: "http://localhost:3000", // The base URL of the server (optional if you're using the same domain)
  plugins: [passkeyClient()],
});

export type Session = typeof authClient.$Infer.Session;
