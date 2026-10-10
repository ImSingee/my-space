import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import { passkey } from '@better-auth/passkey';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { apiKey } from '@better-auth/api-key';
import {
  deviceAuthorization,
  type DeviceAuthorizationGrant,
  type DeviceAuthorizationRequest,
} from 'better-auth/plugins/device-authorization';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { z } from 'zod';

// FIXME: We have to use ../db (rather than ~db) here to make @better-auth/cli happy
// See https://github.com/better-auth/better-auth/issues/6373
import { db, schema } from '../db';
import { getPlatformEnv } from '../env';
import { assertSignupAllowed } from './signup-gate';
import { getPasskeyOriginError, getPasskeyRpId } from './passkey-origin';
import { issuanceEnabled } from './cli-policy';

const { appUrl, betterAuthSecret } = getPlatformEnv();
const relyingPartyId = getPasskeyRpId(appUrl);
const passkeyCeremonyPaths = new Set([
  '/passkey/generate-register-options',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-registration',
  '/passkey/verify-authentication',
]);

const deviceFields = {
  hatchResources: z.string(),
  hatchExpiresIn: z.number(),
  hatchInstanceId: z.string(),
  hatchInstanceEpoch: z.number(),
};
const hatchDeviceGrant = {
  requestSchemaFields: deviceFields,
  deviceCodeSchemaFields: {
    hatchResources: { type: 'string', required: true },
    hatchExpiresIn: { type: 'number', required: true },
    hatchInstanceId: { type: 'string', required: true },
    hatchInstanceEpoch: { type: 'number', required: true },
    hatchSessionId: { type: 'string', required: false },
    hatchUserEpoch: { type: 'number', required: false },
  },
  authorizeRequest: ({ request }: { request: DeviceAuthorizationRequest }) => {
    if (!issuanceEnabled() || request.user_id) throw new APIError('FORBIDDEN');
    const fields = z.object(deviceFields).parse(request);
    return {
      clientId: 'hatch-cli',
      deviceCodeFields: {
        hatchResources: fields.hatchResources,
        hatchExpiresIn: fields.hatchExpiresIn,
        hatchInstanceId: fields.hatchInstanceId,
        hatchInstanceEpoch: fields.hatchInstanceEpoch,
      },
    };
  },
  assertSessionRedemption: () => {
    throw new APIError('FORBIDDEN');
  },
  getVerificationContext: () => undefined,
} satisfies DeviceAuthorizationGrant<typeof deviceFields>;

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
  trustedOrigins: async () => {
    const { getTailscaleManager } = await import('../server/tailscale-manager');
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
      // Hatch's reviewed routes issue keys; the plugins' own HTTP routes stay sealed.
      if (ctx.request && /^\/(?:api-key|device)(?:\/|$)/.test(ctx.path)) {
        throw new APIError('NOT_FOUND');
      }
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
    apiKey({
      configId: 'hatch',
      requireName: true,
      maximumNameLength: 64,
      enableSessionForAPIKeys: false,
      disableKeyHashing: false,
      storage: 'database',
      deferUpdates: false,
      defaultPrefix: 'hatch_',
      enableMetadata: true,
      permissions: { defaultPermissions: {} },
      keyExpiration: {
        minExpiresIn: 300 / 86400,
        maxExpiresIn: 90,
        defaultExpiresIn: 7 * 86400,
      },
    }),
    deviceAuthorization<typeof hatchDeviceGrant>({
      expiresIn: '10m',
      interval: '5s',
      verificationUri: `${appUrl}/cli/authorize`,
      validateClient: (clientId) => clientId === 'hatch-cli',
      grant: hatchDeviceGrant,
    }),
    tanstackStartCookies(), // This should be the last plugin
  ],
});
