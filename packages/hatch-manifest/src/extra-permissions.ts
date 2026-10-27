import { z } from 'zod';

/** Permission names and scoped values are validated by Deno at build time. */
export const extraPermissionsSchema = z
  .array(
    z
      .string()
      .startsWith('--allow-')
      .refine((flag) => !/[\r\n\0]/.test(flag), {
        message: 'permission flags must not contain newlines or NUL',
      }),
  )
  .transform((flags) => [...new Set(flags)]);

/** Merge before spawning: Deno treats bare/scoped duplicates as scoped. */
export function mergeDenoPermissionFlags(
  platformFlags: readonly string[],
  extraFlags: readonly string[] = [],
): string[] {
  const flags = [...platformFlags, ...extraFlags];
  if (flags.includes('--allow-all')) return ['--allow-all'];
  const permissions = new Map<string, Set<string> | null>();
  for (const flag of flags) {
    const separator = flag.indexOf('=');
    const name = separator < 0 ? flag : flag.slice(0, separator);
    if (separator < 0) {
      permissions.set(name, null);
    } else if (permissions.get(name) !== null) {
      const values = permissions.get(name) ?? new Set<string>();
      for (const value of flag.slice(separator + 1).split(','))
        values.add(value);
      permissions.set(name, values);
    }
  }
  return [...permissions].map(([name, values]) =>
    values === null ? name : `${name}=${[...values].join(',')}`,
  );
}

export type ExtraPermissionsView = { flags: string[]; hostAccess: boolean };

export function extraPermissionsView(
  flags: readonly string[] = [],
): ExtraPermissionsView {
  return {
    flags: [...flags],
    hostAccess: flags.some(
      (flag) =>
        [
          '--allow-all',
          '--allow-read',
          '--allow-write',
          '--allow-env',
        ].includes(flag) ||
        ['--allow-run', '--allow-ffi'].includes(flag.split('=', 1)[0]),
    ),
  };
}
