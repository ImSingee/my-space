type PortEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'NITRO_PORT' | 'PORT' | 'HATCH_TAILSCALE_PORT'>
>;

function parsePort(value: string | number, name: string): number {
  const port = Number(value);
  if (
    !/^\d+$/.test(String(value)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

/** Match Nitro's production listener; Vite supplies its development default. */
export function resolvePlatformPort(
  env: PortEnv = process.env,
  fallback = 3000,
): number {
  return parsePort(env.NITRO_PORT ?? env.PORT ?? fallback, 'NITRO_PORT / PORT');
}

/** An explicit proxy target override never changes the Platform listener. */
export function resolveTailscalePort(env: PortEnv = process.env): number {
  return env.HATCH_TAILSCALE_PORT === undefined
    ? resolvePlatformPort(env)
    : parsePort(env.HATCH_TAILSCALE_PORT, 'HATCH_TAILSCALE_PORT');
}
