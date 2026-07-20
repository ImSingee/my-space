import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

// FIXME: We have to use ../db (rather than ~db) here to make @better-auth/cli happy
// See https://github.com/better-auth/better-auth/issues/6373
import { db } from '../db';
import { resolvePlatformSecrets } from '../server/platform-secret';
import { assertSignupAllowed } from './signup-gate';

const { betterAuthSecret } = resolvePlatformSecrets();

// Single-tenant platform: self-service sign-up is a runtime platform setting
// (`auth.allowSignup` in platform_config), toggled from Settings → Users, not
// a build-time env var. Sign-in for existing users always works regardless.
//
// The gate is enforced in `databaseHooks.user.create.before` rather than via
// Better Auth's static `disableSignUp` so a toggle takes effect immediately
// without a restart (the static option is fixed when `auth` is constructed).
// It also has no empty-table bootstrap race: the check reads a config row, not
// the user count, so a fresh deploy defaults to open and can create its owner.
export const auth = betterAuth({
  secret: betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: 'pg',
  }),
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          await assertSignupAllowed();
          return { data: user };
        },
      },
    },
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
