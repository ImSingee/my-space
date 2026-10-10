export const WORKFLOW_BETA_FEATURE = 'workflow';

const ALL_BETA_FEATURES_TOKEN = '*';

/** Parse the Platform-owned, comma-separated beta feature configuration. */
export function parseBetaFeatures(
  value: string | undefined,
): readonly string[] {
  const features = new Set(
    (value ?? '')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  return Object.freeze([...features]);
}

export function hasBetaFeature(
  features: readonly string[],
  feature: string,
): boolean {
  return (
    features.includes(ALL_BETA_FEATURES_TOKEN) || features.includes(feature)
  );
}
