/** Safe credential projection used by the domain and CLI presentation layer. */
type User = { id: string; email: string; name: string };
type Common = {
  authenticated: true;
  authority: 'platform';
  expiresAt: string | null;
};
export type AuthStatus = Common &
  (
    | { credentialType: 'session'; user: User }
    | {
        credentialType: 'api-key';
        user: User;
        key: { id: string; name: string | null };
      }
    | {
        credentialType: 'run';
        context: { runId: string; sessionId: string; runnerId: string };
      }
  );
