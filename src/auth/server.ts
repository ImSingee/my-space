import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { passkey } from '@better-auth/passkey';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { APIError, createAuthMiddleware } from 'better-auth/api';

// FIXME: We have to use ../db (rather than ~db) here to make @better-auth/cli happy
// See https://github.com/better-auth/better-auth/issues/6373
import { db, schema } from '../db';
import { getPlatformEnv } from '../env';
import { assertSignupAllowed } from './signup-gate';
import { getPasskeyOriginError, getPasskeyRpId } from './passkey-origin';

const { appUrl, betterAuthSecret } = getPlatformEnv();
const relyingPartyId = getPasskeyRpId(appUrl);
const passkeyCeremonyPaths = new Set([
  '/passkey/generate-register-options',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-registration',
  '/passkey/verify-authentication',
]);

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
  baseURL: appUrl,
  secret: betterAuthSecret,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  session: {
    // Any valid session may manage credentials without reauthentication.
    // Session expiration and authentication requirements remain enforced.
    freshAge: 0,
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!passkeyCeremonyPaths.has(ctx.path)) return;

      // Check the public origin, not an internal reverse-proxy transport URL.
      // Direct server API calls have no browser headers but still check APP_URL.
      const requestOrigin =
        ctx.headers?.get('origin') ?? ctx.headers?.get('referer') ?? undefined;
      const message = getPasskeyOriginError(appUrl, requestOrigin);
      if (message) {
        throw new APIError('FORBIDDEN', {
          code: 'PASSKEY_ORIGIN_UNSUPPORTED',
          message,
        });
      }
    }),
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
  advanced: {
    database: {
      joins: true,
    },
    // ipAddress: {
    //   ipAddressHeaders: ['x-forwarded-for', 'cf-connecting-ip'],
    // },
  },
  plugins: [
    {
      id: 'verification-retention',
      // Keep the expiry index in the generated auth schema. The platform's
      // background sweep removes abandoned challenges without a verify request.
      schema: {
        verification: {
          fields: {},
          indexes: [{ fields: ['expiresAt'] }],
        },
      },
    },
    // Keep management endpoints and schema available even when ceremonies
    // are disabled. The hook above rejects them before any challenge is stored.
    passkey({
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
      },
      rpID: relyingPartyId,
      rpName: 'Hatch',
      origin: appUrl,
      registration: {
        // Passkeys are an additional sign-in method for an existing account.
        // New accounts continue to use the email/password sign-up flow.
        requireSession: true,
      },
    }),
    tanstackStartCookies(), // This should be the last plugin
  ],
});
