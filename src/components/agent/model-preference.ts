import { useLocalStorage } from '@mantine/hooks';
import { useCallback } from 'react';

export const LAST_SELECTED_MODEL_STORAGE_KEY =
  'hatch.agent.last-selected-model';

function deserializeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remembers an explicit picker choice across chats. Reading the value does not
 * write a fallback, so merely using a model never changes the remembered
 * selection.
 */
export function useLastSelectedModel() {
  const [storedModel, setStoredModel] = useLocalStorage<string | undefined>({
    key: LAST_SELECTED_MODEL_STORAGE_KEY,
    deserialize: deserializeModel,
  });
  const setLastSelectedModel = useCallback(
    (value: string) => setStoredModel(value),
    [setStoredModel],
  );

  return [storedModel ?? null, setLastSelectedModel] as const;
}
