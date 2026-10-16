import { createFileRoute, redirect } from '@tanstack/react-router';
import { hasActiveSession } from '~server/auth';
import { getHomepageDestination } from '~server/homepage';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    if (!(await hasActiveSession())) {
      throw redirect({
        to: '/login',
        search: { redirect: '/' },
        replace: true,
      });
    }
    throw redirect({ href: await getHomepageDestination(), replace: true });
  },
});
