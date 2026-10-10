/** Shared public limits for the human-facing parts of an App identity. */
export const APP_NAME_MAX_LENGTH = 64;
export const APP_SLUG_MAX_LENGTH = 64;

/** Count Unicode code points instead of JavaScript UTF-16 code units. */
export function appNameCharacterLength(name: string): number {
  return [...name].length;
}

export function isAppNameWithinMaxLength(name: string): boolean {
  return appNameCharacterLength(name) <= APP_NAME_MAX_LENGTH;
}
