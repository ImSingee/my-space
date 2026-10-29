import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { APIError, createAuthMiddleware } from 'better-auth/api';

// FIXME: We have to use ../db (rather than ~db) here to make @better-auth/cli happy
// See https://github.com/better-auth/better-auth/issues/6373
import { db, schema } from '../db';
import { getPlatformEnv } from '../env';
import { assertSignupAllowed } from './signup-gate';
import { getPasskeyOriginError, getPasskeyRpId } from './passkey-origin';
import { apiKeyOptions } from './api-key-options';
import { getTailscaleManager } from '../server/tailscale-manager';
import {
  rebaseDeviceGrant,
  tailscaleRequestOrigin,
} from './device-verification';

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
  // Run credentials are minted only by the fleet-authenticated internal API.
  // Do not expose session-to-JWT issuance or an unused public JWKS endpoint.
  disabledPaths: ['/token', '/jwks'],
  trustedOrigins: async () => {
    const origin = getTailscaleManager().trustedOrigin();
    return origin ? [origin] : [];
  },
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
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/device/code') return;

      // A device login started through the bound tailnet URL is approved on
      // that URL, so its verification link must not point at APP_URL.
      const origin = tailscaleRequestOrigin(
        ctx.headers,
        getTailscaleManager().trustedOrigin(),
      );
      if (!origin) return;
      const grant = rebaseDeviceGrant(ctx.context.returned, origin);
      if (grant) return ctx.json(grant);
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
    apiKey(apiKeyOptions),
    jwt({
      disableSettingJwtHeader: true,
      jwt: { issuer: appUrl, audience: 'hatch-run', expirationTime: '5m' },
      jwks: { rotationInterval: 30 * 86400, gracePeriod: 300 },
    }),
    // Keep management endpoints and schema available even when ceremonies
    // are disabled. The hook above rejects them before any challenge is stored.
    passkey({
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
      },
      rpID: relyingPartyId,
      rpName: 'Hatch',
      // Verify the signed client origin against the request's Origin header.
      // Better Auth's shared CSRF gate validates the challenge-cookie request
      // against APP_URL and the currently trusted Tailscale origin.
      registration: {
        // Passkeys are an additional sign-in method for an existing account.
        // New accounts continue to use the email/password sign-up flow.
        requireSession: true,
      },
    }),
    // CLI and mobile login: the device signs in through the browser approval page at
    // /cli/authorize and receives an ordinary session token, which it sends as
    // `Authorization: Bearer`. A native session has the same authority as a
    // browser session. Requests on the trusted Tailscale origin get this page
    // on that origin instead (see the `after` hook).
    deviceAuthorization({
      expiresIn: '10m',
      interval: '5s',
      verificationUri: `${appUrl}/cli/authorize`,
      validateClient: (clientId) =>
        clientId === 'hatch-cli' || clientId === 'hatch-mobile',
    }),
    bearer(),
    tanstackStartCookies(), // This should be the last plugin
  ],
});
