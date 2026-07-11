import { useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { providersQueryOptions } from '~queries/agent';
import type { ModelGroup } from './model-picker';

export function useModelOptions() {
  const { data: providers } = useSuspenseQuery(providersQueryOptions);
  return useMemo(() => {
    const groups: ModelGroup[] = providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        group: provider.name,
        items: provider.models
          .filter((model) => model.enabled)
          .map((model) => ({
            value: `${provider.id}:${model.modelId}`,
            label: model.name,
          })),
      }))
      .filter((group) => group.items.length > 0);
    const first = groups[0]?.items[0]?.value ?? null;
    const available = new Set(
      groups.flatMap((group) => group.items.map((item) => item.value)),
    );
    return { groups, first, available };
  }, [providers]);
}
