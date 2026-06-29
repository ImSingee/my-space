import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

// FIXME: We have to use ../db (rather than ~db) here to make @better-auth/cli happy
// See https://github.com/better-auth/better-auth/issues/6373
import { db } from '../db';

// Single-tenant platform: self-service sign-up is closed in production so a
// public URL can't be used to register into the shared workspace. Open it
// explicitly (e.g. to bootstrap the owner account) with HATCH_ALLOW_SIGNUP=true.
// Local development keeps sign-up open for a frictionless first run; sign-in for
// the existing owner is always available regardless of this setting.
//
// A config-level gate (rather than a read-before-create count check) is
// intentional: it has no empty-table bootstrap race because nothing reads the
// user count before inserting.
const signupEnabled =
  process.env.HATCH_ALLOW_SIGNUP === 'true' ||
  process.env.NODE_ENV !== 'production';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: !signupEnabled,
  },
  experimental: { joins: true },
  // advanced: {
  //   ipAddress: {
  //     ipAddressHeaders: ["x-forwarded-for", "cf-connecting-ip"],
  //   },
  // },
  plugins: [
    tanstackStartCookies(), // This should be the last plugin
  ],
});
