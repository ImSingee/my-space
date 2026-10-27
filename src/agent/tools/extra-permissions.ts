import type { ExtraPermissionsView } from '~/extra-permissions';

export function formatExtraPermissions(
  access: ExtraPermissionsView | null,
): string {
  if (!access) return 'not deployed';
  if (access.flags.length === 0) return 'none declared';
  return (
    access.flags.join(', ') +
    (access.hostAccess
      ? ' (HOST ACCESS: runs as the platform OS user; can access platform credentials and other Apps’ data)'
      : '')
  );
}
