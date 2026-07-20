/** Server-only platform secrets resolved from the process environment. */
export function resolvePlatformSecrets(): {
  secret: string;
  betterAuthSecret: string;
} {
  const secret = process.env.SECRET;
  if (!secret?.trim()) {
    throw new Error('SECRET is not set');
  }

  const configuredBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const betterAuthSecret = configuredBetterAuthSecret?.trim()
    ? configuredBetterAuthSecret
    : secret;
  if (!configuredBetterAuthSecret?.trim()) {
    process.env.BETTER_AUTH_SECRET = betterAuthSecret;
  }

  return { secret, betterAuthSecret };
}
