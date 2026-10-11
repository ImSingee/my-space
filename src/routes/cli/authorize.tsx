import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { authClient } from '~auth/client';
import { DeviceApproval } from '~components/cli-auth/device-approval';
import { normalizeUserCode } from '~components/cli-auth/device-api';
import { hasActiveSession } from '~server/auth';

/** Same-origin path back to this page; it carries only the user code. */
function returnPath(userCode: string): string {
  const code = normalizeUserCode(userCode);
  return code
    ? `/cli/authorize?${new URLSearchParams({ user_code: code })}`
    : '/cli/authorize';
}

export const Route = createFileRoute('/cli/authorize')({
  validateSearch: (search): { user_code?: string | number } => {
    // Keep the value as parsed: normalizing here would make the router rewrite
    // the address bar. An all-digit code is a lossless number; anything that
    // is not a string or number is ignored rather than trusted.
    const value = search.user_code;
    return {
      user_code:
        typeof value === 'string' || typeof value === 'number'
          ? value
          : undefined,
    };
  },
  beforeLoad: async ({ search }) => {
    if (!(await hasActiveSession()))
      throw redirect({
        to: '/login',
        search: { redirect: returnPath(String(search.user_code ?? '')) },
      });
  },
  head: () => ({
    // The root document's `strict-origin` referrer policy keeps the code in
    // this URL out of Referer headers, for direct loads and in-app navigation.
    meta: [{ title: 'Approve a device · Hatch' }],
  }),
  component: AuthorizePage,
});

function AuthorizePage() {
  const { user_code } = Route.useSearch();
  const navigate = useNavigate();
  const session = authClient.useSession();

  const signIn = (userCode: string) =>
    navigate({ to: '/login', search: { redirect: returnPath(userCode) } });

  return (
    <DeviceApproval
      initialCode={String(user_code ?? '')}
      account={session.data?.user.email ?? null}
      onSignIn={signIn}
      onSwitchAccount={async (userCode) => {
        await authClient.signOut();
        await signIn(userCode);
      }}
    />
  );
}
