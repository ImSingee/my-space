/** Canonical name of the platform-owned App SDK/config directory. */
export const APP_MANAGED_DIR = '.hatch';
export const APP_REGISTRY_CONFIG = '.npmrc';
export const APP_UNSUPPORTED_ROOT_CONFIGS = [
  'deno.jsonc',
  'tsconfig.json',
  'jsconfig.json',
] as const;

/**
 * App source can move between case-sensitive and case-insensitive filesystems.
 * Treat every ASCII case variant as the same reserved path segment so a source
 * accepted on Linux cannot alias the platform-owned directory on macOS.
 */
export function isAppManagedPathSegment(segment: string): boolean {
  return segment.toLowerCase() === APP_MANAGED_DIR;
}

/** The App root registry configuration is injected and owned by the platform. */
export function isAppRegistryConfigName(name: string): boolean {
  return name.toLowerCase() === APP_REGISTRY_CONFIG;
}

/** App builds use one canonical root deno.json and no alternate TS config. */
export function isUnsupportedAppRootConfigName(name: string): boolean {
  const normalized = name.toLowerCase();
  return APP_UNSUPPORTED_ROOT_CONFIGS.some(
    (candidate) => candidate === normalized,
  );
}
