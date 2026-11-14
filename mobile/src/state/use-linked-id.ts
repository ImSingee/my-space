import { useQuery } from '@tanstack/react-query';
import { MobileError } from '../core';
import { useSession } from './session';

/**
 * The id of the App or Workflow a screen shows. Links name one by its current
 * slug, passed as both `id` and `slug`. The instance looks resources up by id
 * before slug, and a slug may equal another resource's id, so a link's slug is
 * matched against the list instead. Screens opened from a list pass the id.
 */
export function useLinkedId(
  kind: 'apps' | 'workflows',
  id: string,
  slug: string | undefined,
) {
  const { api, origin } = useSession();
  const bySlug = Boolean(slug) && id === slug;
  // The same query the Apps and Workflows lists keep.
  const list = useQuery({
    queryKey: [origin, kind],
    queryFn: ({ signal }) =>
      kind === 'apps' ? api!.apps(signal) : api!.workflows(signal),
    enabled: Boolean(api) && bySlug,
  });
  if (!bySlug) return { id, error: null, retry: () => {} };
  const retry = () => void list.refetch();
  if (!list.data) return { id: null, error: list.error, retry };
  const match = list.data.find((item) => item.slug === slug);
  return match
    ? { id: match.id, error: null, retry }
    : {
        id: null,
        error: new MobileError(
          'not_found',
          `No ${kind === 'apps' ? 'App' : 'workflow'} is named “${slug}” on this instance.`,
        ),
        retry,
      };
}
