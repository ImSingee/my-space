import { queryOptions } from '@tanstack/react-query';
import { getSignupConfig, getUsersPanelData } from '~server/users';

export const usersPanelQueryOptions = queryOptions({
  queryKey: ['settings', 'users'],
  queryFn: () => getUsersPanelData(),
});

/** Public probe used by the login page to decide whether to offer sign-up. */
export const signupConfigQueryOptions = queryOptions({
  queryKey: ['auth', 'signup-config'],
  queryFn: () => getSignupConfig(),
});
