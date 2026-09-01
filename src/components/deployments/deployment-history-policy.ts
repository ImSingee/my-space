export function requiresAgentRollback(
  deployment:
    | { canRollback: boolean; compatibility: { isSupported: boolean } }
    | undefined,
): boolean {
  return Boolean(
    deployment?.canRollback && !deployment.compatibility.isSupported,
  );
}
