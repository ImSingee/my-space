export function resolveEffectiveModel(
  selected: string | null,
  sessionModel: string | null,
  available: ReadonlySet<string>,
  first: string | null,
): string | null {
  if (selected && available.has(selected)) return selected;
  if (sessionModel && available.has(sessionModel)) return sessionModel;
  return first;
}

/**
 * Decode a model picker value (`<providerId>:<modelId>`). Provider ids are
 * ULIDs (never contain a colon), but model ids legitimately do — e.g.
 * Bedrock-style ids ending in `:0` — so split only on the first separator and
 * keep the remainder intact instead of `split(':')` which would truncate them.
 */
export function splitModelValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}
