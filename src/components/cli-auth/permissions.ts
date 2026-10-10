import type { CliScope, ResourceRange } from '~auth/cli-policy';

/** Plain-language names for each lifecycle scope, grouped by object kind. */
const CAPABILITIES = [
  { key: 'read', label: 'View', changes: false },
  { key: 'source.read', label: 'Read source', changes: false },
  { key: 'create', label: 'Create', changes: true },
  { key: 'deploy', label: 'Deploy', changes: true },
  { key: 'rollback', label: 'Roll back', changes: true },
] as const;

const KINDS = [
  { key: 'app', label: 'Apps', singular: 'app', plural: 'apps' },
  {
    key: 'workflow',
    label: 'Workflows',
    singular: 'workflow',
    plural: 'workflows',
  },
] as const;

type Kind = (typeof KINDS)[number];

function grantedCapabilities(scopes: readonly CliScope[], kind: Kind) {
  const granted = new Set<string>(scopes);
  return CAPABILITIES.filter((c) => granted.has(`${kind.key}.${c.key}`));
}

/** `Apps: View, Read source, Deploy` rows for the details list. */
export function permissionGroups(scopes: readonly CliScope[]) {
  return KINDS.flatMap((kind) => {
    const capabilities = grantedCapabilities(scopes, kind);
    return capabilities.length
      ? [{ label: kind.label, value: capabilities.map((c) => c.label) }]
      : [];
  });
}

/**
 * The decision in one sentence, split so the verb and the object can be
 * emphasized: "read and change" + "all your apps and workflows".
 */
export function permissionSentence(
  scopes: readonly CliScope[],
  resources: ResourceRange,
) {
  const kinds = KINDS.filter(
    (kind) => grantedCapabilities(scopes, kind).length,
  );
  const all = kinds.flatMap((kind) => grantedCapabilities(scopes, kind));
  const reads = all.some((c) => !c.changes);
  const changes = all.some((c) => c.changes);
  const onlyCreate = all.every((c) => c.key === 'create');
  const verb = onlyCreate
    ? 'create'
    : reads && changes
      ? 'read and change'
      : changes
        ? 'change'
        : 'read';

  if (resources.mode === 'all')
    return {
      verb,
      object: `all your ${kinds.map((kind) => kind.plural).join(' and ')}`,
      future: true,
    };
  const counts = KINDS.flatMap((kind) => {
    const count =
      kind.key === 'app' ? resources.apps.length : resources.workflows.length;
    return count
      ? [`${count} ${count === 1 ? kind.singular : kind.plural}`]
      : [];
  });
  return {
    verb,
    object: counts.length ? counts.join(' and ') : 'no apps or workflows',
    future: false,
  };
}
